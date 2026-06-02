import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentRun, type AgentState, createInitialRun, LIVE_AGENT_STATES, type TeamMember } from "./types.ts";
import { type StreamAccumulator, type StreamEvent, applyStreamEvent, createAccumulator } from "./stream-parser.ts";

export type Runner = Readonly<{
	spawn(member: TeamMember, task: string, signal: AbortSignal | undefined): Promise<AgentRun>;
	kill(name: string): boolean;
	list(): readonly AgentRun[];
	get(name: string): AgentRun | undefined;
	shutdown(): void;
}>;

const KILL_GRACE_MS = 2000;

type PiInvocation = { command: string; baseArgs: readonly string[] };

let cachedPiInvocation: PiInvocation | null = null;

const derivePiInvocation = (): PiInvocation => {
	if (cachedPiInvocation) return cachedPiInvocation;
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return (cachedPiInvocation = { command: process.execPath, baseArgs: [currentScript] });
	}
	const executableName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
	return (cachedPiInvocation = isGenericRuntime
		? { command: "pi", baseArgs: [] }
		: { command: process.execPath, baseArgs: [] });
};

const killWithGrace = (child: ChildProcess): void => {
	if (child.killed) return;
	child.kill("SIGTERM");
	setTimeout(() => {
		if (!child.killed) child.kill("SIGKILL");
	}, KILL_GRACE_MS).unref();
};

const writeSystemPromptFile = async (instructions: string): Promise<{ filePath: string; directory: string }> => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nano-team-"));
	const filePath = path.join(directory, "system.md");
	await fs.promises.writeFile(filePath, instructions, { encoding: "utf-8", mode: 0o600 });
	return { filePath, directory };
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

export const createRunner = (cwd: string, onChange: () => void, maxConcurrency = DEFAULT_MAX_CONCURRENCY): Runner => {
	const runs = new Map<string, AgentRun>();
	const children = new Map<string, ChildProcess>();
	const tempDirectories = new Set<string>();
	const spawning = new Set<string>();
	let isShuttingDown = false;
	const semaphore = new Semaphore(maxConcurrency);

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
		let promptFile: { filePath: string; directory: string };
		try {
			promptFile = await writeSystemPromptFile(member.instructions);
			tempDirectories.add(promptFile.directory);
		} catch (error) {
			spawning.delete(member.name);
			throw error;
		}

		const invocation = derivePiInvocation();
		const args = [
			...invocation.baseArgs,
			"--mode", "json",
			"-p",
			"--no-session",
			"--model", member.model,
			"--append-system-prompt", promptFile.filePath,
			task,
		];

		updateRun(member.name, {
			state: "thinking",
			task,
			startedAt: Date.now(),
			endedAt: null,
			transcript: "",
			activity: null,
			lastError: null,
			pid: null,
		});
		spawning.delete(member.name);

		return new Promise<AgentRun>((resolve) => {
			const child = spawn(invocation.command, args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.set(member.name, child);
			updateRun(member.name, { pid: child.pid ?? null });

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

			child.stdout?.on("data", (chunk: Buffer) => {
				pendingLine += chunk.toString("utf-8");
				let newlineIndex = pendingLine.indexOf("\n");
				while (newlineIndex !== -1) {
					consumeLine(pendingLine.slice(0, newlineIndex));
					pendingLine = pendingLine.slice(newlineIndex + 1);
					newlineIndex = pendingLine.indexOf("\n");
				}
			});
			child.stderr?.on("data", (chunk: Buffer) => { stderrBuffer += chunk.toString("utf-8"); });

			const onAbort = (): void => {
				aborted = true;
				killWithGrace(child);
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
				children.delete(member.name);
				tempDirectories.delete(promptFile.directory);
				fs.promises.rm(promptFile.directory, { recursive: true, force: true }).catch(() => {});

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

			child.on("error", (error) => {
				accumulator.errorMessage = error.message;
				if (!children.has(member.name)) finalize(null);
			});
			child.on("close", finalize);
		});
	};

	const shutdown = (): void => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		process.removeListener("exit", shutdown);
		for (const child of children.values()) {
			try { if (!child.killed) child.kill("SIGKILL"); } catch { /* ignore */ }
		}
		children.clear();
		for (const directory of tempDirectories) {
			try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		tempDirectories.clear();
	};

	process.on("exit", shutdown);

	return Object.freeze({
		spawn: (member, task, signal) => semaphore.run(() => spawnAgent(member, task, signal)),
		kill: (name) => {
			const child = children.get(name);
			if (!child) return false;
			killWithGrace(child);
			return true;
		},
		list: () => Array.from(runs.values()),
		get: (name) => runs.get(name),
		shutdown,
	});
};
