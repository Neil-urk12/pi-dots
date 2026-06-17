// Tests for the real ChildProcessAdapter. This is the one place we exercise
// the subprocess lifecycle end-to-end (spawn, error buffering, kill timer,
// temp-file cleanup) — the adapter has no other coverage and the
// error-buffering race is the most likely silent-failure mode.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcessAdapter } from "../process.ts";

const runtime = process.execPath; // bun in this test env

let fakePiPath: string;
let fakeShellSleepPath: string;

beforeAll(async () => {
	const dir = await mkdtemp(join(tmpdir(), "process-test-"));

	// Echoes argv and the contents of the --append-system-prompt file
	// (if any) on stderr. Uses console.error so each line ends with a
	// real newline (avoids the `\\n` template-literal escape trap).
	fakePiPath = join(dir, "fake-pi.mjs");
	await writeFile(
		fakePiPath,
		`import { readFileSync } from "node:fs";
console.error("ARGV_BEGIN");
for (const a of process.argv) console.error("ARGV:" + a);
const i = process.argv.indexOf("--append-system-prompt");
if (i > -1) {
	const p = process.argv[i + 1];
	console.error("PROMPT_PATH:" + p);
	try {
		const content = readFileSync(p, "utf-8");
		console.error("PROMPT_CONTENT_BEGIN");
		console.error(content);
		console.error("PROMPT_CONTENT_END");
	} catch (e) {
		console.error("PROMPT_READ_ERROR:" + e.message);
	}
}
process.exit(0);
`,
	);

	// Shell-based sleep — used by the kill test. We use a shell script
	// instead of `bun run <sleep.mjs>` because bun does not propagate
	// SIGTERM from itself down to its child script (the kill signal is
	// delivered to the bun process, not propagated). POSIX `sh` handles
	// signals directly so this is portable across host shells.
	fakeShellSleepPath = join(dir, "fake-sleep.sh");
	await writeFile(
		fakeShellSleepPath,
		`#!/bin/sh
# Catch SIGTERM: print and stay alive (do not exit).
trap 'echo GOT_SIGTERM >&2' TERM
# Wait forever. The OS will interrupt with SIGKILL when the adapter's
# grace timer fires — SIGKILL is uncatchable and terminates the process.
while true; do sleep 0.05; done
`,
		{ mode: 0o755 },
	);
});

// Returns a capture object whose `buf` property is a live, growing
// string of everything the subprocess has written to stderr. Returning
// a mutable object (rather than a snapshot string) is required: the
// data events fire asynchronously after the call, and the test reads
// `buf` AFTER `waitForClose` returns, so a snapshot would be empty.
const captureStderr = (handle: { stderr: NodeJS.ReadableStream | null }): { buf: string } => {
	const capture = { buf: "" };
	if (handle.stderr) {
		handle.stderr.on("data", (chunk: Buffer | string) => {
			capture.buf += chunk.toString();
		});
	}
	return capture;
};

const waitForClose = (
	handle: { on: (event: "close", listener: (...args: unknown[]) => void) => void },
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
	new Promise((resolve) => {
		handle.on("close", (code, signal) =>
			resolve({ code, signal: signal as NodeJS.Signals | null }),
		);
	});

describe("ChildProcessAdapter", () => {
	test("writes system prompt to a temp file and adds --append-system-prompt to argv", async () => {
		const adapter = new ChildProcessAdapter();
		const sysPrompt = "TEST_SYSTEM_PROMPT_marker_unique_42";
		const handle = await adapter.start(runtime, [fakePiPath], sysPrompt, "/tmp");
		const stderr = captureStderr(handle);
		await waitForClose(handle);
		// Give trailing data events a tick to flush.
		await new Promise((r) => setTimeout(r, 50));
		const out = stderr.buf;

		// The adapter must have:
		// 1. Added --append-system-prompt <path> to the args
		// 2. Created the temp file with the system prompt content
		// 3. The fake-pi reads the file via the path from argv
		const argvLines = out.split("\n").filter((l) => l.startsWith("ARGV:"));
		expect(argvLines.some((l) => l.includes("--append-system-prompt"))).toBe(true);
		expect(
			argvLines.some((l) => /\/nano-team-.+\/system\.md/.test(l)),
		).toBe(true);
		expect(out).toContain("PROMPT_CONTENT_BEGIN");
		expect(out).toContain(sysPrompt);
		expect(out).toContain("PROMPT_CONTENT_END");
	}, 10_000);

	test("cleans up the temp directory after the subprocess closes", async () => {
		const adapter = new ChildProcessAdapter();
		const handle = await adapter.start(runtime, [fakePiPath], "test", "/tmp");
		const stderr = captureStderr(handle);
		await waitForClose(handle);
		await new Promise((r) => setTimeout(r, 50));
		const out = stderr.buf;

		// The [^\s/]+ class excludes whitespace AND '/', so the match
		// stops at the next path separator and captures only the temp
		// dir name (not the trailing /system.md).
		const argvLines = out.split("\n").filter((l) => l.startsWith("ARGV:"));
		// The [^\s/]+ class excludes whitespace AND '/', so the match
		// stops at the next path separator and captures only the temp
		// dir name (not the trailing /system.md).
		const tempDirMatch = argvLines
			.map((l) => l.match(/ARGV:(\/tmp\/nano-team-[^\s\/]+)\/system\.md/))
			.find((m) => m);
		expect(tempDirMatch).toBeDefined();
		const tempDir = tempDirMatch![1]!;

		// The close handler schedules an async rm; poll until it's gone
		// (or the test times out).
		const deadline = Date.now() + 2_000;
		let gone = false;
		while (Date.now() < deadline) {
			try {
				await stat(tempDir);
			} catch {
				gone = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(gone).toBe(true);
	}, 10_000);

	test("buffers error events for late-registered listeners", async () => {
		// The key fragility: the spawn-side error listener must be attached
		// before the consumer calls on("error", ...). If it fires before
		// the consumer registers, the error is buffered and flushed on
		// registration. This regression-locks that pattern.
		const adapter = new ChildProcessAdapter();
		// A non-existent command triggers ENOENT (node) or "Executable
		// not found in $PATH" (bun) asynchronously.
		const handle = await adapter.start(
			"definitely-not-a-real-binary-12345-xyz",
			[],
			"test",
			"/tmp",
		);

		// Give the error event time to fire (it's async after spawn).
		await new Promise((r) => setTimeout(r, 150));

		// Now register the listener. The buffered error should be flushed.
		let captured: Error | null = null;
		handle.on("error", (err) => {
			captured = err;
		});

		expect(captured).not.toBeNull();
		// bun: "Executable not found in $PATH: ..."
		// node: "...spawn ... ENOENT ..."
		expect(captured?.message).toMatch(/Executable not found|ENOENT/);
	}, 10_000);

	test("kill() sends SIGTERM first, then SIGKILL after the grace period", async () => {
		// Use a shell script (not bun) so the SIGTERM signal goes
		// directly to the script's process — bun's child process model
		// doesn't propagate signals down to the JS handler, so the
		// "GOT_SIGTERM" print never fires when the parent kills bun.
		const adapter = new ChildProcessAdapter();
		const handle = await adapter.start("sh", [fakeShellSleepPath], "test", "/tmp");
		const stderr = captureStderr(handle);

		// Wait for the sleep script to start. 200ms is more than enough.
		await new Promise((r) => setTimeout(r, 200));

		const killStart = Date.now();
		handle.kill();
		const closeInfo = await waitForClose(handle);
		const killDuration = Date.now() - killStart;
		await new Promise((r) => setTimeout(r, 50));
		const out = stderr.buf;

		// KILL_GRACE_MS is 2000; allow 1s of buffer.
		expect(killDuration).toBeLessThan(3_000);
		// The shell script caught SIGTERM and printed GOT_SIGTERM before
		// the SIGKILL grace timer fired.
		expect(out).toContain("GOT_SIGTERM");
		// The sleep script ignores SIGTERM, so the adapter's grace timer
		// fires SIGKILL — close event reports SIGKILL as the signal.
		expect(closeInfo.signal).toBe("SIGKILL");
	}, 10_000);
});
