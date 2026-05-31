import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ── Mock child_process (hoisted so vi.mock can reference it) ──

const { mockExecFile } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	execFile: mockExecFile,
}));

// Mock promisify so it works with our mock execFile.
// Node's real promisify has special-case handling for built-in
// functions that doesn't apply to plain vi.fn() mocks.
vi.mock("node:util", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:util")>();
	return {
		...actual,
		promisify: (fn: (...args: unknown[]) => void) => {
			return (...args: unknown[]) =>
				new Promise((resolve, reject) => {
					fn(...args, (err: Error | null, stdout: string, stderr: string) => {
						if (err) reject(err);
						else resolve({ stdout, stderr });
					});
				});
		},
	};
});

import { createGitState } from "./git.js";

// ── Helpers ───────────────────────────────────────────────────

function mockGitSuccess(branch: string, porcelain: string) {
	mockExecFile.mockImplementation(
		(_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
			if (args.includes("--show-current")) {
				cb(null, branch + "\n", "");
			} else if (args.includes("--porcelain")) {
				cb(null, porcelain, "");
			} else {
				cb(new Error(`unexpected args: ${args.join(" ")}`), "", "");
			}
		},
	);
}

function mockGitFailure() {
	mockExecFile.mockImplementation(
		(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
			cb(new Error("not a git repo"), "", "");
		},
	);
}

// ── Tests ─────────────────────────────────────────────────────

describe("createGitState", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ── refresh ────────────────────────────────────────────

	describe("refresh", () => {
		it("parses branch and dirty count on success", async () => {
			mockGitSuccess("main", "M file.ts\n?? new.ts\n");
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			expect(handle.state).toEqual({
				inRepo: true,
				branch: "main",
				dirtyCount: 2,
			});

			expect(mockExecFile).toHaveBeenCalledWith(
				"git",
				["branch", "--show-current"],
				expect.objectContaining({ cwd: "/repo", timeout: 2_000 }),
				expect.any(Function),
			);
			expect(mockExecFile).toHaveBeenCalledWith(
				"git",
				["status", "--porcelain"],
				expect.objectContaining({ cwd: "/repo", timeout: 2_000 }),
				expect.any(Function),
			);
		});

		it("uses 'detached' when branch name is empty", async () => {
			mockGitSuccess("", "");
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();
			expect(handle.state).toEqual({ inRepo: true, branch: "detached", dirtyCount: 0 });
		});
		it("discards stale error when a newer refresh already succeeded", async () => {
			// First refresh: slow, will eventually fail
			// Second refresh: fast, succeeds
			let firstCallback: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
			mockExecFile.mockImplementation(
				(_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
					if (args.includes("--show-current")) {
						if (!firstCallback) {
							firstCallback = cb;
						} else {
							cb(null, "main\n", "");
						}
					} else if (args.includes("--porcelain")) {
						cb(null, "", "");
					}
				},
			);

			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			// Start first refresh (held)
			void handle.refresh();

			// Second refresh completes successfully
			await handle.refresh();
			expect(handle.state).toEqual({ inRepo: true, branch: "main", dirtyCount: 0 });

			// First refresh fails — should be discarded (stale)
			if (firstCallback) firstCallback(new Error("timeout"), "", "");

			// State should still reflect second refresh
			expect(handle.state).toEqual({ inRepo: true, branch: "main", dirtyCount: 0 });
		});

		it("silences git exit-code errors (not a git repo)", async () => {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const exitError = new Error("Command failed: git branch") as Error & { code: number };
			exitError.code = 128;
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
					cb(exitError, "", "");
				},
			);

			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			expect(consoleSpy).not.toHaveBeenCalled();
			expect(handle.state).toEqual({ inRepo: false, dirtyCount: 0 });

			consoleSpy.mockRestore();
		});

		it("logs EACCES permission errors", async () => {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const eaccesError = new Error("spawn git EACCES") as Error & { code: string };
			eaccesError.code = "EACCES";
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
					cb(eaccesError, "", "");
				},
			);

			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			expect(consoleSpy).toHaveBeenCalledWith(
				"[clean-footer] git refresh failed:",
				"spawn git EACCES",
			);
			expect(handle.state).toEqual({ inRepo: false, dirtyCount: 0 });

			consoleSpy.mockRestore();
		});
		it("resets to inRepo=false on error", async () => {
			mockGitSuccess("main", ""); // first call succeeds
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});
			await handle.refresh();
			expect(handle.state.inRepo).toBe(true);

			mockGitFailure(); // second call fails
			await handle.refresh();

			expect(handle.state).toEqual({
				inRepo: false,
				dirtyCount: 0,
			});
		});
		it("discards stale result when a newer refresh starts", async () => {
			// First refresh: slow (uses a delayed callback)
			let firstCallback: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
			mockExecFile.mockImplementation(
				(_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
					if (args.includes("--show-current")) {
						if (!firstCallback) {
							// First call: hold the callback
							firstCallback = cb;
						} else {
							// Second call: resolve immediately
							cb(null, "develop\n", "");
						}
					} else if (args.includes("--porcelain")) {
						cb(null, "M file.ts\n", "");
					}
				},
			);

			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			// Start first refresh (won't complete — firstCallback is held)
			void handle.refresh();

			// Start second refresh (will complete immediately)
			await handle.refresh();

			// State should reflect the second refresh (develop, 1 dirty)
			expect(handle.state).toEqual({
				inRepo: true,
				branch: "develop",
				dirtyCount: 1,
			});

			// Now complete the first refresh — its result should be discarded
			if (firstCallback) firstCallback(null, "main\n", "");

			// State should still be from the second refresh
			expect(handle.state).toEqual({
				inRepo: true,
				branch: "develop",
				dirtyCount: 1,
			});
		});

		it("logs errors with unexpected code (EACCES) to console.error", async () => {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
					const err = new Error("spawn git EACCES") as Error & { code: string };
					err.code = "EACCES";
					cb(err, "", "");
				},
			);

			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			expect(consoleSpy).toHaveBeenCalledWith(
				"[clean-footer] git refresh failed:",
				"spawn git EACCES",
			);
			expect(handle.state).toEqual({ inRepo: false, dirtyCount: 0 });

			consoleSpy.mockRestore();
		});

		it("silences ENOENT spawn errors (git binary not found)", async () => {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const enoentError = new Error("git: command not found") as Error & { code: string };
			enoentError.code = "ENOENT";
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
					cb(enoentError, "", "");
				},
			);

			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			expect(consoleSpy).not.toHaveBeenCalled();
			expect(handle.state).toEqual({ inRepo: false, dirtyCount: 0 });

			consoleSpy.mockRestore();
		});

		it("silences timeout errors (code: null)", async () => {
			const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			const timeoutError = new Error("Command failed: git branch") as Error & { code: null; killed: boolean };
			timeoutError.code = null;
			timeoutError.killed = true;
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
					cb(timeoutError, "", "");
				},
			);

			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			expect(consoleSpy).not.toHaveBeenCalled();
			expect(handle.state).toEqual({ inRepo: false, dirtyCount: 0 });

			consoleSpy.mockRestore();
		});

		it("clears state and skips git when enabled=false", async () => {
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: false,
			});

			await handle.refresh();

			expect(mockExecFile).not.toHaveBeenCalled();
			expect(handle.state).toEqual({
				inRepo: false,
				dirtyCount: 0,
			});
		});

		it("fires onChange listeners after refresh", async () => {
			mockGitSuccess("main", "");
			const onChange = vi.fn();
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
				onChange,
			});

			await handle.refresh();

			expect(onChange).toHaveBeenCalledTimes(1);
		});

		it("fires all onChange listeners", async () => {
			mockGitSuccess("main", "");
			const a = vi.fn();
			const b = vi.fn();
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
				onChange: a,
			});
			handle.onChange(b);

			await handle.refresh();

			expect(a).toHaveBeenCalledTimes(1);
			expect(b).toHaveBeenCalledTimes(1);
		});

		it("passes cwd option through to git commands", async () => {
			mockGitSuccess("main", "");
			const handle = createGitState({
				cwd: "/different/path",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			for (const call of mockExecFile.mock.calls) {
				expect(call[2]).toEqual(expect.objectContaining({ cwd: "/different/path" }));
			}
		});

		it("passes timeout option to git commands", async () => {
			mockGitSuccess("main", "");
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			await handle.refresh();

			for (const call of mockExecFile.mock.calls) {
				expect(call[2]).toEqual(expect.objectContaining({ timeout: 2_000 }));
			}
		});
	});

	// ── schedule / debounce ────────────────────────────────

	describe("schedule", () => {
		it("debounces rapid calls into one refresh", async () => {
			mockGitSuccess("main", "");
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 300,
				enabled: true,
			});

			handle.schedule();
			handle.schedule();
			handle.schedule();
			handle.schedule();
			handle.schedule();

			expect(mockExecFile).not.toHaveBeenCalled(); // still waiting

			await vi.advanceTimersByTimeAsync(300);

			// Two calls: branch + status (parallel)
			expect(mockExecFile).toHaveBeenCalledTimes(2);
		});

		it("resets debounce timer on each call", async () => {
			mockGitSuccess("main", "");
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 300,
				enabled: true,
			});

			handle.schedule();
			await vi.advanceTimersByTimeAsync(200); // not yet
			handle.schedule(); // reset
			await vi.advanceTimersByTimeAsync(200); // still not yet
			expect(mockExecFile).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(100); // now 300ms since last schedule
			expect(mockExecFile).toHaveBeenCalledTimes(2);
		});
	});

	// ── clear ──────────────────────────────────────────────

	describe("clear", () => {
		it("stops pending scheduled refresh", async () => {
			mockGitSuccess("main", "");
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 300,
				enabled: true,
			});

			handle.schedule();
			handle.clear();

			await vi.advanceTimersByTimeAsync(500);
			expect(mockExecFile).not.toHaveBeenCalled();
		});

		it("is safe to call when no timer is pending", () => {
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 300,
				enabled: true,
			});

			expect(() => handle.clear()).not.toThrow();
		});
	});

	// ── onChange ────────────────────────────────────────────

	describe("onChange", () => {
		it("adds and notifies listeners", async () => {
			mockGitSuccess("main", "");
			const listener = vi.fn();
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			const unsub = handle.onChange(listener);
			await handle.refresh();

			expect(listener).toHaveBeenCalledTimes(1);

			unsub();
			await handle.refresh();

			expect(listener).toHaveBeenCalledTimes(1); // not called again
		});

		it("supports multiple listeners", async () => {
			mockGitSuccess("main", "");
			const a = vi.fn();
			const b = vi.fn();
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			handle.onChange(a);
			handle.onChange(b);
			await handle.refresh();

			expect(a).toHaveBeenCalledTimes(1);
			expect(b).toHaveBeenCalledTimes(1);
		});

		it("unsubscribe is safe to call twice", () => {
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 500,
				enabled: true,
			});

			const unsub = handle.onChange(() => {});
			unsub();
			expect(() => unsub()).not.toThrow();
		});
	});

	// ── timer cleanup ──────────────────────────────────────

	describe("timer cleanup", () => {
		it("leaves no dangling timers after clear", () => {
			const handle = createGitState({
				cwd: "/repo",
				debounceMs: 300,
				enabled: true,
			});

			handle.schedule();
			expect(vi.getTimerCount()).toBeGreaterThan(0);

			handle.clear();
			expect(vi.getTimerCount()).toBe(0);
		});
	});
});
