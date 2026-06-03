import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentRun, createInitialRun, LIVE_AGENT_STATES, type TeamMember } from "./types.ts";
import { type StreamEvent, applyStreamEvent, createAccumulator } from "./stream-parser.ts";
import { type ProcessFactory, type ProcessHandle, ChildProcessAdapter } from "./process.ts";

export type Runner = Readonly<{
	spawn(member: TeamMember, task: string, signal: AbortSignal | undefined): Promise<AgentRun>;
	kill(name: string): boolean;
	list(): readonly AgentRun[];
	get(name: string): AgentRun | undefined;
	shutdown(): void;
}>;

type PiInvocation = { command: string; baseArgs: readonly string[] };

const derivePiInvocation = (): PiInvocation => {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, baseArgs: [currentScript] };
	}
	const executableName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
	return isGenericRuntime
		? { command: "pi", baseArgs: [] }
		: { command: process.execPath, baseArgs: [] };
};

const DEFAULT_MAX_CONCURRENCY = 4;

class Semaphore {
	private inFlight = 0;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.inFlight >= this.max) {
			await new Promise<void>((r) => this.waiters.push(r));
		}
		this.inFlight++;
		try {
			return await fn();
		} finally {
			this.inFlight--;
			const next = this.waiters.shift();
			if (next) next();
		}
	}
}

export const createRunner = (
	cwd: string,
	onChange: () => void,
	maxConcurrency = DEFAULT_MAX_CONCURRENCY,
	factory: ProcessFactory = new ChildProcessAdapter(),
): Runner => {
	const runs = new Map<string, AgentRun>();
	const handles = new Map<string, ProcessHandle>();
	const spawning = new Set<string>();
	let cachedInvocation: PiInvocation | null = null;
	let isShuttingDown = false;
	const semaphore = new Semaphore(maxConcurrency);

	const resolveInvocation = (): PiInvocation => {
		if (!cachedInvocation) cachedInvocation = derivePiInvocation();
		return cachedInvocation;
	};

	const updateRun = (name: string, patch: Partial<AgentRun>): void => {
		const previous = runs.get(name) ?? createInitialRun(name);
		runs.set(name, { ...previous, ...patch });
		onChange();
	};

	const spawnAgent = async (
		member: TeamMember,
		task: string,
		signal: AbortSignal | undefined,
	): Promise<AgentRun> => {
		const existingRun = runs.get(member.name);
		if (spawning.has(member.name) || (existingRun && LIVE_AGENT_STATES.has(existingRun.state))) {
			throw new Error(`agent '${member.name}' is already running (state=${existingRun?.state ?? "spawning"})`);
		}
		if (signal?.aborted) throw new Error(`spawn aborted before start for '${member.name}'`);

		spawning.add(member.name);

		const invocation = resolveInvocation();
		const baseArgs = [
			...invocation.baseArgs,
			"--mode", "json",
			"-p",
			"--no-session",
			"--model", member.model,
		];

		let handle: ProcessHandle;
		try {
			handle = await factory.start(invocation.command, baseArgs, member.instructions, cwd);
		} catch (error) {
			spawning.delete(member.name);
			throw error;
		}

		handles.set(member.name, handle);
		updateRun(member.name, {
			state: "thinking",
			task,
			startedAt: Date.now(),
			endedAt: null,
			transcript: "",
			activity: null,
			lastError: null,
			pid: handle.pid ?? null,
		});
		spawning.delete(member.name);

		return new Promise<AgentRun>((resolve) => {
			const accumulator = createAccumulator();
			accumulator.state = "thinking";
			let aborted = false;
			let stderrBuffer = "";
			let pendingLine = "";
			let resolved = false;

			const consumeLine = (line: string): void => {
				if (line.length === 0) return;
				let parsed: unknown;
				try { parsed = JSON.parse(line); } catch { return; }
				if (!parsed || typeof parsed !== "object") return;
				const event = parsed as StreamEvent;
				if (typeof event.type !== "string") return;
				if (!applyStreamEvent(accumulator, event)) return;
				updateRun(member.name, {
					state: accumulator.state,
					transcript: accumulator.transcript,
					activity: accumulator.activity,
				});
			};

			handle.stdout.on("data", (chunk: Buffer) => {
				pendingLine += chunk.toString("utf-8");
				let newlineIndex = pendingLine.indexOf("\n");
				while (newlineIndex !== -1) {
					consumeLine(pendingLine.slice(0, newlineIndex));
					pendingLine = pendingLine.slice(newlineIndex + 1);
					newlineIndex = pendingLine.indexOf("\n");
				}
			});
			handle.stderr.on("data", (chunk: Buffer) => { stderrBuffer += chunk.toString("utf-8"); });

			const onAbort = (): void => {
				aborted = true;
				handle.kill();
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			const finalize = (exitCode: number | null): void => {
				if (resolved) return;
				resolved = true;
				if (pendingLine.length > 0) consumeLine(pendingLine);
				signal?.removeEventListener("abort", onAbort);
				handles.delete(member.name);

				const failed =
					aborted ||
					exitCode !== 0 ||
					accumulator.stopReason === "error" ||
					accumulator.stopReason === "aborted" ||
					accumulator.errorMessage !== undefined;

				if (!failed) {
					updateRun(member.name, { state: "done", endedAt: Date.now(), activity: null, lastError: null, pid: null });
				} else {
					const trimmedStderr = stderrBuffer.trim();
					const lastError =
						accumulator.errorMessage ??
						(trimmedStderr.length > 0 ? trimmedStderr : null) ??
						(aborted ? "aborted" : null) ??
						`pi exited with code ${exitCode ?? "unknown"}`;
					updateRun(member.name, { state: "error", endedAt: Date.now(), activity: null, lastError, pid: null });
				}
				resolve(runs.get(member.name) ?? createInitialRun(member.name, task));
			};

			handle.on("error", (error) => {
				accumulator.errorMessage = error.message;
				if (!handles.has(member.name)) finalize(null);
			});
			handle.on("close", finalize);
		});
	};

	const shutdown = (): void => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		process.removeListener("exit", shutdown);
		for (const handle of handles.values()) {
			handle.kill();
		}
		handles.clear();
	};

	process.on("exit", shutdown);

	return Object.freeze({
		spawn: (member, task, signal) => semaphore.run(() => spawnAgent(member, task, signal)),
		kill: (name) => {
			const handle = handles.get(name);
			if (!handle) return false;
			handle.kill();
			return true;
		},
		list: () => Array.from(runs.values()),
		get: (name) => runs.get(name),
		shutdown,
	});
};
