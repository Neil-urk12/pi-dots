import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
	spawn: vi.fn(),
}));
vi.mock("@mariozechner/pi-coding-agent", () => ({
	withFileMutationQueue: vi.fn((_path: string, fn: () => Promise<void>) => fn()),
	DEFAULT_MAX_BYTES: 50000,
	DEFAULT_MAX_LINES: 1000,
	truncateHead: vi.fn((s: string) => ({ content: s, truncated: false })),
}));
vi.mock("./provider-resolver", () => ({
	resolveProviderExtension: vi.fn().mockResolvedValue("/ext/provider.js"),
}));
vi.mock("./format", () => ({
	extractToolArgsPreview: vi.fn().mockReturnValue(""),
}));

import * as childProcess from "node:child_process";

const mockExecFileSync = vi.mocked(childProcess.execFileSync);
const mockSpawn = vi.mocked(childProcess.spawn);

function makeMockProc(exitCode = 0) {
	return {
		stdout: {
			on: vi.fn((event: string, cb: Function) => {
				if (event === "data") {
					const evt = JSON.stringify({
						type: "message_end",
						message: { role: "assistant", content: [{ type: "text", text: "done" }] },
					});
					cb(Buffer.from(evt + "\n"));
				}
			}),
		},
		stderr: { on: vi.fn() },
		on: vi.fn((event: string, cb: Function) => {
			if (event === "close") {
				Promise.resolve().then(() => cb(exitCode));
			}
		}),
		kill: vi.fn(),
		killed: false,
	} as any;
}

describe("createSubagentRunner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSpawn.mockReturnValue(makeMockProc(0));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses execFileSync (not execSync) for model polling", async () => {
		// execFileSync returns model list showing the model is available
		mockExecFileSync.mockReturnValue("anthropic claude-sonnet-4-6\n");

		const { createSubagentRunner } = await import("./runner");
		const runner = createSubagentRunner({
			piBin: { command: "/usr/bin/pi", baseArgs: [] },
			builtinTools: new Set(),
			customToolExtensions: {},
		});

		await runner.run(
			{
				name: "test",
				description: "test",
				tools: [],
				model: "anthropic/claude-sonnet-4-6",
				systemPrompt: "test",
				filePath: "/test.md",
			},
			"do something",
			"/tmp",
		);

		// Verify execFileSync was called (not execSync)
		expect(mockExecFileSync).toHaveBeenCalled();

		// Verify args passed as array (not shell-escaped string)
		const callArgs = mockExecFileSync.mock.calls[0];
		expect(Array.isArray(callArgs[1])).toBe(true);
		expect(callArgs[1]).toContain("--list-models");

		// Verify no JSON.stringify shell escaping — args should be raw strings
		for (const arg of callArgs[1] as string[]) {
			expect(arg).not.toMatch(/^"/);
			expect(arg).not.toMatch(/"$/);
		}
	});

	it("does not pass --model when agent.model is undefined", async () => {
		mockExecFileSync.mockReturnValue("");

		const { createSubagentRunner } = await import("./runner");
		const runner = createSubagentRunner({
			piBin: { command: "/usr/bin/pi", baseArgs: [] },
			builtinTools: new Set(),
			customToolExtensions: {},
		});

		const spawnCallsBefore = mockSpawn.mock.calls.length;

		await runner.run(
			{
				name: "test",
				description: "test",
				tools: [],
				systemPrompt: "test",
				filePath: "/test.md",
			},
			"do something",
			"/tmp",
		);

		// The spawn call should not include --model
		const spawnCall = mockSpawn.mock.calls[spawnCallsBefore];
		expect(spawnCall).toBeDefined();
		const spawnArgs = spawnCall[1] as string[];
		const modelIdx = spawnArgs.indexOf("--model");
		expect(modelIdx).toBe(-1);
	});
});