import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentRun, type AgentState, createInitialRun, LIVE_AGENT_STATES, type TeamMember } from "./types.ts";
import { applyStreamEvent, createAccumulator, type StreamEvent } from "./stream-parser.ts";
import { type ProcessFactory, type ProcessHandle, ChildProcessAdapter } from "./process.ts";
import { getErrorMessage } from "./errors.ts";

export type Subagent = Readonly<{
	spawn(
		member: TeamMember,
		task: string,
		signal: AbortSignal | undefined,
		timeoutMs?: number,
	): Promise<Readonly<AgentRun>>;
	kill(name: string): boolean;
	list(): readonly Readonly<AgentRun>[];
	get(name: string): Readonly<AgentRun> | undefined;
	subscribe(listener: () => void): () => void;
	shutdown(): void;
}>;

type PiInvocation = { command: string; baseArgs: readonly string[] };

export type SubagentOptions = Readonly<{
	factory?: ProcessFactory;
	now?: () => number;
	maxConcurrency?: number;
	/** @internal test seam — bypasses process.argv inspection */
	resolveInvocation?: () => PiInvocation;
}>;

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

export const createSubagent = (cwd: string, options: SubagentOptions = {}): Subagent => {
	const factory: ProcessFactory = options.factory ?? new ChildProcessAdapter();
	const now: () => number = options.now ?? (() => Date.now());
	const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	const resolveInvocation: () => PiInvocation = options.resolveInvocation ?? derivePiInvocation;

	const runs = new Map<string, AgentRun>();
	const handles = new Map<string, ProcessHandle>();
	const listeners = new Set<() => void>();
	let cachedInvocation: PiInvocation | null = null;
	let isShuttingDown = false;
	const semaphore = new Semaphore(maxConcurrency);

	const getInvocation = (): PiInvocation => {
		if (!cachedInvocation) cachedInvocation = resolveInvocation();
		return cachedInvocation;
	};

	const notify = (): void => {
		for (const listener of listeners) listener();
	};

	const updateRun = (name: string, patch: Partial<AgentRun>): void => {
		const previous = runs.get(name) ?? createInitialRun(name);
		runs.set(name, { ...previous, ...patch });
		notify();
	};

	const spawnAgent = async (
		member: TeamMember,
		task: string,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
	): Promise<AgentRun> => {
		if (isShuttingDown) throw new Error(`subagent is shut down`);

		const existingRun = runs.get(member.name);
		if (existingRun && LIVE_AGENT_STATES.has(existingRun.state)) {
			throw new Error(`agent '${member.name}' is already running (state=${existingRun.state})`);
		}
		if (signal?.aborted) throw new Error(`spawn aborted before start for '${member.name}'`);

		// Transition to "thinking" synchronously so a concurrent spawn sees us as live
		// before any async work. If factory.start() fails below, we transition to "error"
		// with the failure message — the run store remains the single source of truth.
		updateRun(member.name, {
			state: "thinking",
			task,
			startedAt: now(),
			endedAt: null,
			transcript: "",
			activity: null,
			lastError: null,
			pid: null,
		});

		const invocation = getInvocation();
		const baseArgs = [
			...invocation.baseArgs,
			"--mode", "json",
			"-p",
			"--no-session",
		];
		// If the team member has no model, omit --model so the subprocess
		// falls back to pi's default (matching @narumitw/pi-subagents).
		if (member.model !== undefined) {
			baseArgs.push("--model", member.model);
		}
		// The user-supplied task is the actual prompt for the subprocess.
		// Without it, pi in -p mode has nothing to process and exits
		// immediately. The system prompt is passed separately via
		// --append-system-prompt by the adapter (see ChildProcessAdapter).
		baseArgs.push(`Task: ${task}`);

		let handle: ProcessHandle;
		try {
			handle = await factory.start(invocation.command, baseArgs, member.instructions, cwd);
		} catch (error) {
			updateRun(member.name, {
				state: "error",
				endedAt: now(),
				lastError: getErrorMessage(error),
			});
			throw error;
		}

		handles.set(member.name, handle);
		updateRun(member.name, { pid: handle.pid ?? null });

		// Declared at the function scope (NOT inside the inner try) so the
		// `finally` block can always clear it, even if an earlier statement
		// in the try throws before the timer is scheduled.
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

		try {
			// Local mirror of the run's state. Kept in sync via updateRun()
			// below; the functional stream-parser API returns whether anything
			// changed so we only notify subscribers on real transitions.
			const acc = createAccumulator();
			acc.state = "thinking";
			let aborted = false;
			let stderrBuffer = "";
			let pendingLine = "";
			let resolved = false;
			let timeoutFired = false;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeoutHandle = setTimeout(() => {
					timeoutFired = true;
					handle.kill();
				}, timeoutMs);
				timeoutHandle.unref?.();
			}

			const consumeLine = (line: string): void => {
				if (line.length === 0) return;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					return;
				}
				if (!parsed || typeof parsed !== "object") return;
				const event = parsed as StreamEvent;
				if (typeof event.type !== "string") return;
				if (!applyStreamEvent(acc, event)) return;
				updateRun(member.name, {
					state: acc.state,
					transcript: acc.transcript,
					activity: acc.activity,
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

			handle.stderr.on("data", (chunk: Buffer) => {
				stderrBuffer += chunk.toString("utf-8");
			});

			const onAbort = (): void => {
				// A timeout already flipped the state — don't overwrite the
				// reason with a generic "aborted" label.
				if (timeoutFired) return;
				aborted = true;
				handle.kill();
			};
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			const finalState: { state: AgentState; endedAt: number; lastError: string | null } =
				await new Promise((resolve) => {
					const finalize = (exitCode: number | null): void => {
						if (resolved) return;
						resolved = true;
						if (timeoutHandle) {
							clearTimeout(timeoutHandle);
							timeoutHandle = null;
						}
						if (pendingLine.length > 0) consumeLine(pendingLine);
						signal?.removeEventListener("abort", onAbort);
						const failed =
							aborted ||
							exitCode !== 0 ||
							acc.stopReason === "error" ||
							acc.stopReason === "aborted" ||
							acc.errorMessage !== undefined;
						if (!failed) {
							resolve({ state: "done", endedAt: now(), lastError: null });
							return;
						}
						const trimmedStderr = stderrBuffer.trim();
						const lastError =
							acc.errorMessage ??
							(trimmedStderr.length > 0 ? trimmedStderr : null) ??
							(timeoutFired ? `timed out after ${timeoutMs}ms` : null) ??
							(aborted ? "aborted" : null) ??
							`pi exited with code ${exitCode ?? "unknown"}`;
						resolve({ state: "error", endedAt: now(), lastError });
					};
					handle.on("error", (error) => {
						acc.errorMessage = error.message;
						finalize(null);
					});
					handle.on("close", finalize);
				});

			updateRun(member.name, {
				state: finalState.state,
				endedAt: finalState.endedAt,
				activity: null,
				lastError: finalState.lastError,
				pid: null,
			});
		} catch (error) {
			// Defensive: if the body throws before reaching the final updateRun
			// (e.g. a synchronous throw from updateRun itself, a bad chunk
			// decoder, or an exception in the stream-parser path), transition
			// the run to error explicitly so it doesn't stay stuck in
			// 'thinking' forever — a real failure mode the lyra / orion
			// reviews surfaced.
			updateRun(member.name, {
				state: "error",
				endedAt: now(),
				activity: null,
				lastError: getErrorMessage(error),
				pid: null,
			});
			throw error;
		} finally {
			// Always clear the SIGKILL grace timer — without this it would
			// fire after a clean exit and call kill() on a dead handle.
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
			handles.delete(member.name);
		}

		return runs.get(member.name) ?? createInitialRun(member.name, task);
	};

	const shutdown = (): void => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		process.off("exit", onProcessExit);
		for (const handle of handles.values()) {
			handle.kill();
		}
		handles.clear();
		listeners.clear();
	};

	const onProcessExit = (): void => {
		shutdown();
	};

	process.on("exit", onProcessExit);

	return Object.freeze({
		spawn: (member, task, signal, timeoutMs) =>
			semaphore.run(() => spawnAgent(member, task, signal, timeoutMs)),
		kill: (name) => {
			const handle = handles.get(name);
			if (!handle) return false;
			handle.kill();
			return true;
		},
		list: () => Array.from(runs.values()),
		get: (name) => runs.get(name),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		shutdown,
	});
};
