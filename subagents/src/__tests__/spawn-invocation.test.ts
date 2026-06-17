// Regression tests for the spawn() invocation contract. These pin down what
// the subagent is REQUIRED to pass to the ProcessFactory so the bug we
// just fixed (task being dropped from baseArgs) can't come back.
//
// We use a fake factory that just records params — we don't want to mock
// the ChildProcessAdapter's behavior here, that's covered by the existing
// subagent.test.ts. The "what reaches the subprocess" behavior is verified
// separately via the real ChildProcessAdapter against a fake "pi" binary
// (repro-adapter.ts in the repo root, runnable via `bun repro-adapter.ts`).

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createSubagent } from "../subagent.ts";
import type { ProcessFactory, ProcessHandle } from "../process.ts";
import type { TeamMember } from "../types.ts";

type FakeHandle = ProcessHandle & {
	emitClose(code: number | null): void;
	killed: boolean;
};

type SpawnCall = {
	command: string;
	args: readonly string[];
	instructions: string;
	cwd: string;
};

const createFakeFactory = (): { factory: ProcessFactory; calls: SpawnCall[]; handles: FakeHandle[] } => {
	const calls: SpawnCall[] = [];
	const handles: FakeHandle[] = [];

	const factory: ProcessFactory = {
		async start(command, args, instructions, cwd): Promise<ProcessHandle> {
			calls.push({ command, args: [...args], instructions, cwd });

			const stdout = new PassThrough();
			const stderr = new PassThrough();
			const closeListeners: Array<(code: number | null) => void> = [];
			let killed = false;

			const handle: FakeHandle = {
				stdout,
				stderr,
				pid: 1000 + handles.length,
				on(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
					if (event === "close") closeListeners.push(listener as (code: number | null) => void);
				},
				kill() { killed = true; },
				emitClose(code: number | null) {
					stdout.end();
					stderr.end();
					for (const fn of closeListeners) fn(code);
				},
				get killed() { return killed; },
			};

			handles.push(handle);
			return handle;
		},
	};

	return { factory, calls, handles };
};

const member = (overrides: Partial<TeamMember> = {}): TeamMember =>
	Object.freeze({
		name: "test-agent",
		role: "coder",
		instructions: "SYSTEM: you are a test agent.",
		task: "DEFAULT",
		model: "test-model",
		sourceFile: "test.yaml",
		...overrides,
	});

describe("spawn() — required argv", () => {
	test("user task is the LAST positional argument in baseArgs", async () => {
		const { factory, calls, handles } = createFakeFactory();
		const subagent = createSubagent("/test/cwd", { factory });

		const userTask = "USER_TASK_read all .ts files and list them";
		const promise = subagent.spawn(member(), userTask, undefined);
		await new Promise((r) => setTimeout(r, 5));
		handles[0]!.emitClose(0);
		await promise;

		const args = calls[0]!.args;
		expect(args[args.length - 1]).toBe(`Task: ${userTask}`);
	});

	test("baseArgs always contains --mode json -p --no-session", async () => {
		const { factory, calls, handles } = createFakeFactory();
		const subagent = createSubagent("/test/cwd", { factory });

		const promise = subagent.spawn(member(), "task", undefined);
		await new Promise((r) => setTimeout(r, 5));
		handles[0]!.emitClose(0);
		await promise;

		const args = calls[0]!.args;
		expect(args).toContain("--mode");
		expect(args).toContain("json");
		expect(args).toContain("-p");
		expect(args).toContain("--no-session");
	});

	test("--model is included when the team member has a model", async () => {
		const { factory, calls, handles } = createFakeFactory();
		const subagent = createSubagent("/test/cwd", { factory });

		const promise = subagent.spawn(member({ model: "anthropic/claude-sonnet-4-5" }), "task", undefined);
		await new Promise((r) => setTimeout(r, 5));
		handles[0]!.emitClose(0);
		await promise;

		const args = calls[0]!.args;
		const i = args.indexOf("--model");
		expect(i).toBeGreaterThanOrEqual(0);
		expect(args[i + 1]).toBe("anthropic/claude-sonnet-4-5");
	});

	test("--model is OMITTED when the team member has no model (inherits pi's default)", async () => {
		const { factory, calls, handles } = createFakeFactory();
		const subagent = createSubagent("/test/cwd", { factory });

		const promise = subagent.spawn(member({ model: undefined }), "task", undefined);
		await new Promise((r) => setTimeout(r, 5));
		handles[0]!.emitClose(0);
		await promise;

		const args = calls[0]!.args;
		expect(args).not.toContain("--model");
	});

	test("system prompt is passed to factory.start as the 3rd argument (the adapter writes it to a temp file)", async () => {
		const { factory, calls, handles } = createFakeFactory();
		const subagent = createSubagent("/test/cwd", { factory });

		const sysPrompt = "SYSTEM: you are a test agent.";
		const promise = subagent.spawn(member({ instructions: sysPrompt }), "task", undefined);
		await new Promise((r) => setTimeout(r, 5));
		handles[0]!.emitClose(0);
		await promise;

		// The factory contract is: instructions is the system prompt string.
		// The real ChildProcessAdapter writes it to a temp file and adds
		// --append-system-prompt. The fake factory just records it.
		expect(calls[0]!.instructions).toBe(sysPrompt);
	});
});
