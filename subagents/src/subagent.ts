import * as fs from "node:fs";
import * as path from "node:path";
import { type AgentRun, type AgentState, createInitialRun, isLiveState, type TeamMember } from "./types.ts";
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
	/**
	 * Terminates the run with the given `instanceId`. Returns true if a live
	 * run was found and killed; false if no such run exists.
	 */
	kill(instanceId: string): boolean;
	list(): readonly Readonly<AgentRun>[];
	/** Looks up a single run by `instanceId`. */
	get(instanceId: string): Readonly<AgentRun> | undefined;
	/** Returns every run (live and terminal) for the given agent name, in spawn order. */
	getByName(name: string): readonly Readonly<AgentRun>[];
	/** Returns the subset of `getByName(name)` whose state is `thinking` or `working`. */
	getLiveByName(name: string): readonly Readonly<AgentRun>[];
	subscribe(listener: () => void): () => void;
	shutdown(): void;
}>;

type PiInvocation = { command: string; baseArgs: readonly string[] };

export type SubagentOptions = Readonly<{
	factory?: ProcessFactory;
	now?: () => number;
	maxConcurrency?: number;
	/**
	 * Maximum number of runs retained in the runs map. When exceeded,
	 * the oldest terminal-state entry is evicted on the next spawn.
	 * Live runs are never evicted. Defaults to 200.
	 *
	 * @internal — primarily a test seam. End users rarely need to tune this.
	 */
	maxRetainedRuns?: number;
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
const DEFAULT_MAX_RETAINED_RUNS = 200;

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
	const maxRetainedRuns = options.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS;
	const resolveInvocation: () => PiInvocation = options.resolveInvocation ?? derivePiInvocation;

	// Primary stores are keyed by `instanceId`. The `nameToInstances` index
	// is the cheap path for name-based lookups (kill/status by name with
	// disambiguation; flusher widget grouping; /subagents-doctor output).
	// Terminal-state and failed-spawn entries are evicted by
	// `evictOldestTerminalRun` once the map exceeds `maxRetainedRuns`;
	// see that helper for the policy.
	const runs = new Map<string, AgentRun>();
	const handles = new Map<string, ProcessHandle>();
	const nameToInstances = new Map<string, string[]>();
	const counters = new Map<string, number>();
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

	/**
	 * Mints `${name}-${n}` for the next run of this name. Synchronous: the
	 * caller increments the counter and reserves the id before any async
	 * subprocess work, so concurrent spawns of the same name cannot collide.
	 */
	const mintInstanceId = (name: string): string => {
		const next = (counters.get(name) ?? 0) + 1;
		counters.set(name, next);
		return `${name}-${next}`;
	};

	const indexAdd = (name: string, instanceId: string): void => {
		const list = nameToInstances.get(name);
		if (list === undefined) nameToInstances.set(name, [instanceId]);
		else list.push(instanceId);
	};

	const indexRemove = (name: string, instanceId: string): void => {
		const list = nameToInstances.get(name);
		if (list === undefined) return;
		const idx = list.indexOf(instanceId);
		if (idx !== -1) list.splice(idx, 1);
		if (list.length === 0) nameToInstances.delete(name);
	};

	/**
	 * Evict the oldest terminal-state run from `runs`. Live runs
	 * (`thinking` or `working`) are skipped — if every entry is live,
	 * this is a no-op and the caller keeps growing past the cap until
	 * something terminates. Cleans up the `nameToInstances` index so
	 * stale instanceIds don't linger.
	 */
	const evictOldestTerminalRun = (): void => {
		let oldestKey: string | null = null;
		let oldestStartedAt = Infinity;
		for (const [key, run] of runs) {
			if (isLiveState(run.state)) continue;
			if (run.startedAt < oldestStartedAt) {
				oldestStartedAt = run.startedAt;
				oldestKey = key;
			}
		}
		if (oldestKey === null) return;
		const removed = runs.get(oldestKey);
		runs.delete(oldestKey);
		if (removed !== undefined) {
			indexRemove(removed.name, oldestKey);
		}
	};

	const updateRun = (instanceId: string, patch: Partial<AgentRun>): void => {
		const previous = runs.get(instanceId);
		if (previous === undefined) return;
		runs.set(instanceId, { ...previous, ...patch });
		notify();
	};

	const spawnAgent = async (
		member: TeamMember,
		task: string,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
	): Promise<AgentRun> => {
		if (isShuttingDown) throw new Error(`subagent is shut down`);

		// Duplicate-spawn policy: read-only agents (TeamMember.readOnly === true)
		// may have multiple concurrent live instances. Write-capable agents
		// preserve the single-slot invariant — the second concurrent spawn
		// rejects with the same error message callers used to see.
		if (member.readOnly !== true) {
			// The runs map is keyed by `instanceId`, not by name — look up the
			// agent's live instanceIds via the index and check each one.
			const liveInstances = nameToInstances.get(member.name) ?? [];
			for (const id of liveInstances) {
				const existingRun = runs.get(id);
				if (existingRun && isLiveState(existingRun.state)) {
					throw new Error(`agent '${member.name}' is already running (state=${existingRun.state})`);
				}
			}
		}
		if (signal?.aborted) throw new Error(`spawn aborted before start for '${member.name}'`);

		// Mint the instance id synchronously so concurrent spawns of the
		// same read-only agent cannot race the counter.
		const instanceId = mintInstanceId(member.name);
		runs.set(instanceId, createInitialRun(member.name, instanceId, task));
		indexAdd(member.name, instanceId);

		// Transition to "thinking" synchronously so a concurrent spawn sees
		// us as live before any async work. If factory.start() fails below,
		// we transition to "error" — the run store remains the single source
		// of truth. `task` was already set by `createInitialRun` above; this
		// patch carries only the state-machine transition so the invariants
		// stay explicit.
		updateRun(instanceId, {
			state: "thinking",
			startedAt: now(),
		});

		// Bound the runs map: when we exceed `maxRetainedRuns`, evict the
		// oldest terminal-state entry. Live runs are never evicted; if every
		// entry is live (e.g. the semaphore is fully booked), the map grows
		// past the cap until something terminates. The check runs after the
		// "thinking" transition so the new entry's `startedAt` is `now()`,
		// not 0 from the initialiser — preventing self-eviction.
		if (runs.size > maxRetainedRuns) {
			evictOldestTerminalRun();
		}

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
			updateRun(instanceId, {
				state: "error",
				endedAt: now(),
				lastError: getErrorMessage(error),
			});
			throw error;
		}

		handles.set(instanceId, handle);
		updateRun(instanceId, { pid: handle.pid ?? null });

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
				updateRun(instanceId, {
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

			updateRun(instanceId, {
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
			updateRun(instanceId, {
				state: "error",
				endedAt: now(),
				activity: null,
				lastError: getErrorMessage(error),
				pid: null,
			});
			throw error;
		} finally {
			// Backstop clear: `finalize` already cleared `timeoutHandle` on
			// the success path, so this is the throw-path safety net. If the
			// body throws before `finalize` runs (e.g. a synchronous error
			// in stream setup), the SIGKILL grace timer would otherwise fire
			// against a dead handle.
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
			handles.delete(instanceId);
		}

		const finalRun = runs.get(instanceId);
		if (finalRun === undefined) {
			// Should be unreachable: we minted and indexed this id ourselves.
			// Reachable when shutdown() runs between spawn() and close and
			// clears the runs map. Returning a fresh AgentRun here keeps the
			// promise well-formed so callers do not see a spurious rejection
			// for an otherwise-completed spawn.
			return createInitialRun(member.name, instanceId, task);
		}
		return finalRun;
	};

	const shutdown = (): void => {
		if (isShuttingDown) return;
		isShuttingDown = true;
		process.off("exit", onProcessExit);
		for (const handle of handles.values()) {
			handle.kill();
		}
		handles.clear();
		runs.clear();
		nameToInstances.clear();
		counters.clear();
		listeners.clear();
	};

	const onProcessExit = (): void => {
		shutdown();
	};

	process.on("exit", onProcessExit);

	return Object.freeze({
		spawn: (member, task, signal, timeoutMs) =>
			semaphore.run(() => spawnAgent(member, task, signal, timeoutMs)),
		kill: (instanceId) => {
			const handle = handles.get(instanceId);
			if (!handle) return false;
			handle.kill();
			return true;
		},
		list: () => Array.from(runs.values()),
		get: (instanceId) => runs.get(instanceId),
		getByName: (name) => {
			const ids = nameToInstances.get(name);
			if (ids === undefined) return [];
			const out: AgentRun[] = [];
			for (const id of ids) {
				const run = runs.get(id);
				if (run !== undefined) out.push(run);
			}
			return out;
		},
		getLiveByName: (name) => {
			const ids = nameToInstances.get(name);
			if (ids === undefined) return [];
			const out: AgentRun[] = [];
			for (const id of ids) {
				const run = runs.get(id);
				if (run !== undefined && isLiveState(run.state)) out.push(run);
			}
			return out;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		shutdown,
	});
};
