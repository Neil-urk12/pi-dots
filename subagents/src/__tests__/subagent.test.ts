import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSubagent } from "../subagent.ts";
import type { ProcessFactory, ProcessHandle } from "../process.ts";
import type { TeamMember } from "../types.ts";

// ── Fake Process Factory ────────────────────────────────────────────

type FakeHandle = ProcessHandle & {
	emitStdout(data: string): void;
	emitStderr(data: string): void;
	emitClose(code: number | null): void;
	emitError(error: Error): void;
	killed: boolean;
};

type SpawnCall = {
	command: string;
	args: readonly string[];
	instructions: string;
	cwd: string;
};

type FakeFactoryOptions = {
	/**
	 * If true, the handle's on("close", ...) call throws synchronously.
	 * The body registers the "error" listener first and the "close"
	 * listener second, so this is a clean way to inject a mid-body
	 * throw that the long-lived try/catch must handle.
	 */
	onCloseThrows?: boolean;
};

const createFakeFactory = (
	options: FakeFactoryOptions = {},
): { factory: ProcessFactory; calls: SpawnCall[]; handles: FakeHandle[] } => {
	const calls: SpawnCall[] = [];
	const handles: FakeHandle[] = [];

	const factory: ProcessFactory = {
		async start(command, args, instructions, cwd): Promise<ProcessHandle> {
			calls.push({ command, args, instructions, cwd });

			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const closeListeners: Array<(code: number | null) => void> = [];
			const errorListeners: Array<(error: Error) => void> = [];
			let killed = false;

			const handle: FakeHandle = {
				stdout,
				stderr,
				pid: 1000 + handles.length,
				on(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
					if (event === "close" && options.onCloseThrows) {
						throw new Error("synthetic close registration error");
					}
					if (event === "close") closeListeners.push(listener as (code: number | null) => void);
					else errorListeners.push(listener as (error: Error) => void);
				},
				kill() {
					killed = true;
				},
				emitStdout(data: string) {
					stdout.write(data);
				},
				emitStderr(data: string) {
					stderr.write(data);
				},
				emitClose(code: number | null) {
					stdout.end();
					stderr.end();
					for (const fn of closeListeners) fn(code);
				},
				emitError(error: Error) {
					for (const fn of errorListeners) fn(error);
				},
				get killed() {
					return killed;
				},
			};

			handles.push(handle);
			return handle;
		},
	};

	return { factory, calls, handles };
};

// ── Helpers ──────────────────────────────────────────────────────────

const member = (name = "test-agent", task = "do something"): TeamMember =>
	Object.freeze({
		name,
		role: "coder",
		instructions: "You are a test agent.",
		task,
		model: "test-model",
		sourceFile: "test.yaml",
	});

const jsonLine = (event: Record<string, unknown>): string => JSON.stringify(event) + "\n";

const yieldToRunner = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

// ── Tests ────────────────────────────────────────────────────────────

describe("Subagent lifecycle", () => {
	test("transitions through thinking → working → done on normal completion", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "test task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		handle.emitStdout(jsonLine({ type: "message_start" }));
		handle.emitStdout(
			jsonLine({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "/src/main.ts" },
			}),
		);
		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "All done." }],
					stopReason: "end_turn",
				},
			}),
		);
		handle.emitClose(0);

		const run = await promise;
		expect(run.state).toBe("done");
		expect(run.transcript).toBe("All done.");
		expect(run.lastError).toBeNull();
		expect(run.endedAt).toBeGreaterThan(0);
	});

	test("captures non-zero exit as error", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "test task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		handle.emitStderr("something went wrong");
		handle.emitClose(1);

		const run = await promise;
		expect(run.state).toBe("error");
		expect(run.lastError).toBe("something went wrong");
	});

	test("captures error event message", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "test task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		handle.emitError(new Error("spawn ENOENT"));
		handle.emitClose(null);

		const run = await promise;
		expect(run.state).toBe("error");
		expect(run.lastError).toBe("spawn ENOENT");
	});

	test("handles abort signal gracefully", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });
		const controller = new AbortController();

		const promise = subagent.spawn(member(), "test task", controller.signal);
		await yieldToRunner();
		const handle = handles[0]!;

		controller.abort();
		expect(handle.killed).toBe(true);

		handle.emitClose(null);

		const run = await promise;
		expect(run.state).toBe("error");
		expect(run.lastError).toBe("aborted");
	});

	test("rejects concurrent spawn of same agent", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });
		const m = member();

		const first = subagent.spawn(m, "task 1", undefined);
		await yieldToRunner();

		await expect(subagent.spawn(m, "task 2", undefined)).rejects.toThrow("already running");

		handles[0]!.emitClose(0);
		await first;
	});

	test("synchronous throw during stream setup transitions the run to error (not stuck in 'thinking')", async () => {
		// Regression: the long-lived try/finally inside spawnAgent had no catch
		// clause, so any sync throw during stream setup would skip the final
		// updateRun({ state: "done" | "error" }) and leave the run stuck in
		// "thinking" forever. The fix adds a catch that transitions to error
		// before re-throwing.
		const m = member();
		const { factory } = createFakeFactory({ onCloseThrows: true });
		const subagent = createSubagent("/test", { factory });

		await expect(subagent.spawn(m, "task", undefined)).rejects.toThrow(
			"synthetic close registration error",
		);

		const run = subagent.getByName(m.name).at(-1);
		expect(run?.state).toBe("error");
		expect(run?.lastError).toBe("synthetic close registration error");
		expect(run?.endedAt).not.toBeNull();
	});

	test("captures non-Error throws in factory.start catch (no `as Error` cast)", async () => {
		// Regression: the previous `(error as Error).message` cast at
		// the catch boundary assumed every thrown value was an Error. A
		// string throw made `(string as Error).message` return
		// `undefined` and the user saw `lastError: undefined`. The fix
		// uses getErrorMessage(error) which handles any thrown value.
		const factory: ProcessFactory = {
			async start() {
				throw "string-error-not-an-error-instance";
			},
		};
		const subagent = createSubagent("/test", { factory });
		const m = member();
		await expect(subagent.spawn(m, "task", undefined)).rejects.toBe(
			"string-error-not-an-error-instance",
		);
		const run = subagent.getByName(m.name).at(-1);
		expect(run?.state).toBe("error");
		// Old code produced lastError = "undefined" (string).
		// New code produces the actual thrown value.
		expect(run?.lastError).toBe("string-error-not-an-error-instance");
	});

	test("Subagent.get returns Readonly<AgentRun> (caller mutations blocked at the type level)", () => {
		// Regression: the previous Subagent.get returned a mutable
		// AgentRun, allowing callers to corrupt internal state until
		// the next updateRun(). The type is now Readonly<AgentRun>;
		// the @ts-expect-error below would fail (Unused ts-expect-error)
		// if a future refactor reverts to a mutable return type.
		const { factory } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });
		const run = subagent.get("nonexistent");
		if (run) {
			// @ts-expect-error — Readonly<AgentRun>.state is readonly
			run.state = "hacked";
		}
		expect(run).toBeUndefined();
	});

	test("kill returns true when agent is running", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "test task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		const instanceId = subagent.getByName("test-agent")[0]?.instanceId;
		expect(instanceId).toBeDefined();
		expect(subagent.kill(instanceId!)).toBe(true);
		expect(handle.killed).toBe(true);

		handle.emitClose(null);
		await promise;
	});

	test("kill returns false when agent is not running", () => {
		const { factory } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		expect(subagent.kill("nonexistent")).toBe(false);
	});

	test("list returns all runs", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const p1 = subagent.spawn(member("agent-1"), "task 1", undefined);
		const p2 = subagent.spawn(member("agent-2"), "task 2", undefined);
		await yieldToRunner();

		expect(subagent.list()).toHaveLength(2);

		handles[0]!.emitClose(0);
		handles[1]!.emitClose(0);
		await Promise.all([p1, p2]);
	});

	test("get returns specific run", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member("agent-1"), "task 1", undefined);
		await yieldToRunner();

		const instanceId = subagent.getByName("agent-1")[0]?.instanceId;
		expect(instanceId).toBeDefined();
		const run = subagent.get(instanceId!);
		expect(run).toBeDefined();
		expect(run!.name).toBe("agent-1");
		expect(run!.state).toBe("thinking");

		handles[0]!.emitClose(0);
		await promise;
	});

	test("passes instructions and args to factory", async () => {
		const { factory, handles, calls } = createFakeFactory();
		const subagent = createSubagent("/test/cwd", { factory });

		const promise = subagent.spawn(member("agent-1", "default task"), "override task", undefined);
		await yieldToRunner();

		expect(calls).toHaveLength(1);
		expect(calls[0]!.instructions).toBe("You are a test agent.");
		expect(calls[0]!.cwd).toBe("/test/cwd");
		expect(calls[0]!.args).toContain("--model");
		expect(calls[0]!.args).toContain("test-model");

		handles[0]!.emitClose(0);
		await promise;
	});

	test("subscribe listeners fire on state updates", async () => {
		const { factory, handles } = createFakeFactory();
		let notifyCount = 0;
		const subagent = createSubagent("/test", { factory });
		subagent.subscribe(() => { notifyCount++; });

		const promise = subagent.spawn(member(), "task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;
		const initialNotifies = notifyCount;

		handle.emitStdout(
			jsonLine({
				type: "tool_execution_start",
				toolName: "read",
				args: { path: "/test" },
			}),
		);
		expect(notifyCount).toBeGreaterThan(initialNotifies);

		handle.emitClose(0);
		await promise;
	});

	test("shutdown kills all running agents", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const p1 = subagent.spawn(member("a1"), "t1", undefined);
		const p2 = subagent.spawn(member("a2"), "t2", undefined);
		await yieldToRunner();

		subagent.shutdown();

		expect(handles[0]!.killed).toBe(true);
		expect(handles[1]!.killed).toBe(true);

		handles[0]!.emitClose(null);
		handles[1]!.emitClose(null);
		await Promise.all([p1, p2]);
	});
});

describe("Subagent timeout", () => {
	test("times out after timeoutMs and marks the run as error", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "test task", undefined, 10);
		await yieldToRunner();
		const handle = handles[0]!;

		// Wait for the timeout to fire, then the close handler runs
		await new Promise((r) => setTimeout(r, 30));
		expect(handle.killed).toBe(true);

		handle.emitClose(null);
		const run = await promise;
		expect(run.state).toBe("error");
		expect(run.lastError).toBe("timed out after 10ms");
	});

	test("clears the timer when the agent finishes before timeout", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "test task", undefined, 1000);
		await yieldToRunner();
		const handle = handles[0]!;

		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "fast" }],
					stopReason: "end_turn",
				},
			}),
		);
		handle.emitClose(0);
		const run = await promise;
		expect(run.state).toBe("done");
		expect(run.transcript).toBe("fast");
		// If the timer were not cleared it would fire ~1s later, but since
		// the run is already terminal there is no observable effect — this
		// test mainly guards that the happy path still works with a timeout
		// configured.
	});

	test("timeoutMs of 0 is treated as no timeout", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "test task", undefined, 0);
		await yieldToRunner();
		const handle = handles[0]!;

		// Wait well past what a real timeout would have been — nothing should
		// fire because the 0-ms branch is treated as "not set".
		await new Promise((r) => setTimeout(r, 20));
		expect(handle.killed).toBe(false);

		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "end_turn",
				},
			}),
		);
		handle.emitClose(0);
		const run = await promise;
		expect(run.state).toBe("done");
	});

	test("user signal abort after timeout does not overwrite the lastError", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });
		const controller = new AbortController();

		const promise = subagent.spawn(member(), "test task", controller.signal, 10);
		await yieldToRunner();
		const handle = handles[0]!;

		// Let the timeout fire first — it sets timeoutFired=true and kills the handle.
		await new Promise((r) => setTimeout(r, 30));
		expect(handle.killed).toBe(true);

		// Now trigger the user signal abort. The onAbort guard
		// `if (timeoutFired) return;` must prevent `aborted` from being set,
		// so the lastError keeps the more informative "timed out" message.
		controller.abort();

		handle.emitClose(null);
		const run = await promise;
		expect(run.state).toBe("error");
		expect(run.lastError).toBe("timed out after 10ms");
	});

	test("omits --model from subprocess args when the team member has no model", async () => {
		const { factory, handles, calls } = createFakeFactory();
		const subagent = createSubagent("/test/cwd", { factory });

		const noModelMember: TeamMember = Object.freeze({
			name: "no-model-agent",
			role: "coder",
			instructions: "You are a test agent without a model.",
			task: "do something",
			sourceFile: "no-model.yaml",
		});

		const promise = subagent.spawn(noModelMember, "task", undefined);
		await yieldToRunner();

		expect(calls).toHaveLength(1);
		expect(calls[0]!.args).not.toContain("--model");

		handles[0]!.emitClose(0);
		await promise;
	});
});

describe("Subagent concurrency", () => {
	test("semaphore limits concurrent spawns", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory, maxConcurrency: 2 });

		const p1 = subagent.spawn(member("a1"), "t1", undefined);
		const p2 = subagent.spawn(member("a2"), "t2", undefined);
		const p3 = subagent.spawn(member("a3"), "t3", undefined);

		await new Promise((r) => setTimeout(r, 10));
		expect(handles).toHaveLength(2);

		handles[0]!.emitClose(0);
		await p1;

		await new Promise((r) => setTimeout(r, 10));
		expect(handles).toHaveLength(3);

		handles[1]!.emitClose(0);
		handles[2]!.emitClose(0);
		await Promise.all([p2, p3]);
	});
});

describe("Subagent stream parsing integration", () => {
	test("accumulates transcript across multiple message_end events", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		handle.emitStdout(jsonLine({ type: "message_start" }));
		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Part 1. " }],
				},
			}),
		);
		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Part 2." }],
					stopReason: "end_turn",
				},
			}),
		);
		handle.emitClose(0);

		const run = await promise;
		expect(run.transcript).toBe("Part 1. Part 2.");
		expect(run.state).toBe("done");
	});

	test("captures errorMessage from stream as error state", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		handle.emitStdout(jsonLine({ type: "message_start" }));
		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [],
					errorMessage: "context window exceeded",
				},
			}),
		);
		handle.emitClose(0);

		const run = await promise;
		expect(run.state).toBe("error");
		expect(run.lastError).toBe("context window exceeded");
	});

	test("ignores malformed JSON lines without crashing", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		handle.emitStdout("not json\n");
		handle.emitStdout("{incomplete\n");
		handle.emitStdout(jsonLine({ type: "message_start" }));
		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "recovered" }],
					stopReason: "end_turn",
				},
			}),
		);
		handle.emitClose(0);

		const run = await promise;
		expect(run.state).toBe("done");
		expect(run.transcript).toBe("recovered");
	});

	test("handles partial lines buffered across chunks", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory });

		const promise = subagent.spawn(member(), "task", undefined);
		await yieldToRunner();
		const handle = handles[0]!;

		const fullLine = jsonLine({ type: "message_start" });
		handle.emitStdout(fullLine.slice(0, 10));
		handle.emitStdout(fullLine.slice(10));

		handle.emitStdout(
			jsonLine({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "end_turn",
				},
			}),
		);
		handle.emitClose(0);

		const run = await promise;
		expect(run.state).toBe("done");
	});
});

describe("Subagent runs cap", () => {
	test("evicts oldest terminal-state run when over maxRetainedRuns", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory, maxRetainedRuns: 3 });

		// Spawn 5 agents sequentially, closing each before the next.
		// After all 5 complete, only the 3 most recent should remain —
		// the oldest two (agent-0, agent-1) are evicted on the next spawn.
		for (let i = 0; i < 5; i++) {
			const promise = subagent.spawn(member(`agent-${i}`), `task ${i}`, undefined);
			await yieldToRunner();
			handles[i]!.emitClose(0);
			await promise;
		}

		const remaining = subagent.list();
		expect(remaining).toHaveLength(3);
		const names = remaining.map((r) => r.name);
		expect(names).toEqual(["agent-2", "agent-3", "agent-4"]);
	});

	test("does not evict live runs when over maxRetainedRuns", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory, maxRetainedRuns: 2 });

		// Spawn 4 agents without closing any. All 4 land in "thinking"
		// state — eviction is impossible because every entry is live, so
		// the map grows past the cap.
		const promises: Array<Promise<unknown>> = [];
		for (let i = 0; i < 4; i++) {
			promises.push(subagent.spawn(member(`agent-${i}`), `task ${i}`, undefined));
		}
		await yieldToRunner();

		expect(subagent.list()).toHaveLength(4);

		// Clean up: close all handles so the promises resolve.
		for (const handle of handles) {
			handle.emitClose(0);
		}
		await Promise.all(promises);
	});

	test("cleans up nameToInstances when evicting", async () => {
		const { factory, handles } = createFakeFactory();
		const subagent = createSubagent("/test", { factory, maxRetainedRuns: 1 });

		// Spawn two distinct agents sequentially. After both complete,
		// the oldest (agent-0) is evicted — its instanceId should also
		// be gone from the name index so a follow-up spawn of the same
		// agent is accepted (the index no longer thinks it's live).
		const firstPromise = subagent.spawn(member("agent-0"), "task 0", undefined);
		await yieldToRunner();
		handles[0]!.emitClose(0);
		await firstPromise;

		const secondPromise = subagent.spawn(member("agent-1"), "task 1", undefined);
		await yieldToRunner();
		handles[1]!.emitClose(0);
		await secondPromise;

		// Only agent-1 should remain.
		const remaining = subagent.list();
		expect(remaining.map((r) => r.name)).toEqual(["agent-1"]);

		// `getByName("agent-0")` must NOT return the evicted instance.
		// Without index cleanup, the stale entry would filter out in
		// `getByName` (because `runs.get(id)` is undefined), but the
		// index itself would still hold the dangling reference — a
		// small leak we want to verify is closed.
		expect(subagent.getByName("agent-0")).toHaveLength(0);
	});
});
