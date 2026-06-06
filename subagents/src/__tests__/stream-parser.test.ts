// Replace src/__tests__/stream-parser-class.test.ts with this complete file
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { StreamParser } from "../stream-parser.ts";
import { type ProcessHandle } from "../process.ts";
import { type AgentRun } from "../types.ts";

const jsonLine = (event: Record<string, unknown>): string => JSON.stringify(event) + "\n";

const buildMockProcess = (options: {
	exitCode?: number | null;
	emitError?: Error;
} = {}) => {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const listeners = new Map<string, Array<Function>>();

	const handle: ProcessHandle & {
		emitClose(code: number | null): void;
		emitError(error: Error): void;
		killed: boolean;
	} = {
		stdout,
		stderr,
		pid: 1234,
		killed: false,
		on: (event: string, fn: Function) => {
			const list = listeners.get(event) ?? [];
			list.push(fn);
			listeners.set(event, list);
		},
		off: (event: string, fn: Function) => {
			const list = listeners.get(event) ?? [];
			listeners.set(event, list.filter((x) => x !== fn));
		},
		kill: () => {
			handle.killed = true;
		},
		emitClose: (code: number | null) => {
			stdout.end();
			stderr.end();
			const list = listeners.get("close") ?? [];
			for (const fn of list) fn(code);
		},
		emitError: (err: Error) => {
			const list = listeners.get("error") ?? [];
			for (const fn of list) fn(err);
		},
	};
	return handle;
};

describe("StreamParser Class Details", () => {
	test("transitions through thinking, working and done", async () => {
		const handle = buildMockProcess();
		const updates: Array<Partial<AgentRun>> = [];
		const parser = new StreamParser("agent", "task", {
			onUpdate: (p) => updates.push(p),
			now: () => 2000,
		});

		const promise = parser.parse(handle);
		handle.stdout.write(jsonLine({ type: "message_start" }));
		handle.stdout.write(jsonLine({ type: "tool_execution_start", toolName: "read", args: { path: "main.ts" } }));
		handle.stdout.write(jsonLine({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Finished successfully" }], stopReason: "end_turn" },
		}));
		handle.emitClose(0);

		const result = await promise;
		expect(result.state).toBe("done");
		expect(result.endedAt).toBe(2000);
		expect(updates.map((u) => u.state)).toEqual(["thinking", "working", "working"]);
		expect(updates[updates.length - 1]!.transcript).toBe("Finished successfully");
	});

	test("captures stderr on failure exit", async () => {
		const handle = buildMockProcess();
		const parser = new StreamParser("agent", "task", {
			onUpdate: () => {},
			now: () => 3000,
		});

		const promise = parser.parse(handle);
		handle.stderr.write("some error in shell\n");
		handle.emitClose(1);

		const result = await promise;
		expect(result.state).toBe("error");
		expect(result.lastError).toBe("some error in shell");
	});

	test("handles process error event", async () => {
		const handle = buildMockProcess();
		const parser = new StreamParser("agent", "task", {
			onUpdate: () => {},
			now: () => 4000,
		});

		const promise = parser.parse(handle);
		handle.emitError(new Error("process fail"));
		handle.emitClose(null);

		const result = await promise;
		expect(result.state).toBe("error");
		expect(result.lastError).toBe("process fail");
	});

	test("gracefully terminates on abort signal", async () => {
		const handle = buildMockProcess();
		const controller = new AbortController();
		const parser = new StreamParser("agent", "task", {
			onUpdate: () => {},
			now: () => 5000,
		});

		const promise = parser.parse(handle, controller.signal);
		controller.abort();
		expect(handle.killed).toBe(true);
		handle.emitClose(null);

		const result = await promise;
		expect(result.state).toBe("error");
		expect(result.lastError).toBe("aborted");
	});
});
