import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Mocks ──────────────────────────────────────────────────────
// Hoisted — takes effect before any real imports.

vi.mock("./git.js", () => {
	const listeners: Array<() => void> = [];
	const fakeRefresh = vi.fn(async () => {
		for (const cb of listeners) cb();
	});

	return {
		createGitState: vi.fn((opts: { onChange?: () => void }) => {
			if (opts.onChange) listeners.push(opts.onChange);
			return {
				get state() {
					return { inRepo: true, branch: "main", dirtyCount: 0 };
				},
				schedule: vi.fn(),
				clear: vi.fn(() => {
					listeners.length = 0;
				}),
				refresh: fakeRefresh,
				onChange: vi.fn(),
			};
		}),
	};
});

vi.mock("./tokens.js", () => {
	return {
		accumulateTotals: vi.fn(() => ({
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
		})),
	};
});

// ── Imports (real — but git.js and tokens.js are already mocked) ──

import { FooterLifecycle } from "./lifecycle.js";
import { createGitState } from "./git.js";
import { accumulateTotals } from "./tokens.js";

// ── Helpers ────────────────────────────────────────────────────

function makeMockCtx(overrides?: Partial<ExtensionContext> & { branchLength?: number }): ExtensionContext {
	const { branchLength, ...rest } = overrides ?? {};
	return {
		cwd: "/home/user/projects/my-project",
		hasUI: false,
		model: {
			id: "anthropic/claude-sonnet-4-20250514",
			contextWindow: 200_000,
		} as ExtensionContext["model"],
		getContextUsage: () => ({ tokens: 84_000 }),
		sessionManager: {
			getBranch: () => Array(branchLength ?? 0).fill({ type: "message", message: { role: "assistant" } }),
		} as unknown as ExtensionContext["sessionManager"],
		ui: {} as ExtensionContext["ui"],
		...rest,
	} as ExtensionContext;
}

function createLifecycle(): {
	lifecycle: FooterLifecycle;
	onRenderNeeded: ReturnType<typeof vi.fn>;
} {
	const onRenderNeeded = vi.fn();
	const lifecycle = new FooterLifecycle({
		globalConfigPath: "/nonexistent/global.json",
		getProjectConfigPath: () => "/nonexistent/project.json",
		getThinkingLevel: () => undefined,
		onRenderNeeded: () => onRenderNeeded(),
	});
	return { lifecycle, onRenderNeeded };
}

// ── Tests ──────────────────────────────────────────────────────

describe("FooterLifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── Construction ─────────────────────────────────────────

	describe("constructor", () => {
		it("starts with default config and enabled", () => {
			const { lifecycle } = createLifecycle();
			expect(lifecycle.isEnabled).toBe(true);
			expect(lifecycle.config.enabled).toBe(true);
			expect(lifecycle.loadedError).toBeUndefined();
			expect(lifecycle.loadedPaths).toEqual([]);
		});
	});

	// ── start / shutdown ────────────────────────────────────

	describe("start", () => {
		it("loads config and creates git handle", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());

			expect(createGitState).toHaveBeenCalledTimes(1);
			expect(lifecycle.loadedError).toBeUndefined();
		});

		it("triggers render via git onChange during start", async () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			// onRenderNeeded fires during start because git refresh
			// invokes onChange listeners
			await lifecycle.start(makeMockCtx());
			expect(onRenderNeeded).toHaveBeenCalled();
		});

		it("does not crash in non-interactive context", async () => {
			const { lifecycle } = createLifecycle();
			await expect(
				lifecycle.start(makeMockCtx({ hasUI: false })),
			).resolves.toBeUndefined();
		});
	});

	describe("shutdown", () => {
		it("clears git handle when it exists", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock
				.results[0]?.value;

			lifecycle.shutdown();
			expect(handle.clear).toHaveBeenCalledTimes(1);
		});

		it("is safe to call without start", () => {
			const { lifecycle } = createLifecycle();
			expect(() => lifecycle.shutdown()).not.toThrow();
		});
	});

	// ── Thinking level ──────────────────────────────────────

	describe("onThinkingLevel", () => {
		it("triggers render", () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			lifecycle.onThinkingLevel("high");
			expect(onRenderNeeded).toHaveBeenCalledTimes(1);
		});

		it("accepts all valid levels without error", () => {
			const { lifecycle } = createLifecycle();
			expect(() => {
				lifecycle.onThinkingLevel("low");
				lifecycle.onThinkingLevel("medium");
				lifecycle.onThinkingLevel("med");
				lifecycle.onThinkingLevel("high");
				lifecycle.onThinkingLevel("extra-high");
				lifecycle.onThinkingLevel("xhigh");
			}).not.toThrow();
		});
	});

	describe("onModelSelect", () => {
		it("triggers render", () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			lifecycle.onModelSelect();
			expect(onRenderNeeded).toHaveBeenCalledTimes(1);
		});
	});

	describe("onMessageEnd", () => {
		it("triggers render when role is 'assistant'", () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			lifecycle.onMessageEnd("assistant");
			expect(onRenderNeeded).toHaveBeenCalledTimes(1);
		});

		it("skips render for other roles", () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			lifecycle.onMessageEnd("user");
			lifecycle.onMessageEnd("system");
			expect(onRenderNeeded).not.toHaveBeenCalled();
		});
	});
	describe("onMessageStart", () => {
		it("records start time for assistant role", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			// No direct assertion — just ensure no crash
		});

		it("ignores non-assistant roles", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("user");
			lifecycle.onMessageStart("toolResult");
			// No crash, no state change
		});
	});
	describe("tok/s computation", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("computes tok/s from assistant message", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000); // 1 second elapsed
			lifecycle.onMessageEnd("assistant", 100);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.lastTokPerSec).toBe(100);
		});

		it("computes exact tok/s value", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2250); // 1.25 seconds elapsed
			lifecycle.onMessageEnd("assistant", 500);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.lastTokPerSec).toBe(400); // 500 / 1.25 = 400
		});

		it("returns raw tok/s without rounding", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(1700); // 0.7 seconds elapsed
			lifecycle.onMessageEnd("assistant", 100); // 100 / 0.7 ≈ 142.857

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.lastTokPerSec).toBeCloseTo(142.857, 2);
		});

		it("sets undefined when no output tokens", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onMessageEnd("assistant", 0);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.lastTokPerSec).toBeUndefined();
		});

		it("sets undefined when elapsed time is zero", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(1000); // same time — 0 elapsed
			lifecycle.onMessageEnd("assistant", 100);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.lastTokPerSec).toBeUndefined();
		});

		it("does not compute for non-assistant messages", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("user");
			lifecycle.onMessageEnd("user", 100);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.lastTokPerSec).toBeUndefined();
		});

		it("resets tok/s after reload", async () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageEnd("assistant", 100);

			await lifecycle.reload(makeMockCtx());
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.lastTokPerSec).toBeUndefined();
		});
	});

	describe("onToolEnd", () => {
		it("triggers render for any tool", () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			lifecycle.onToolEnd("bash");
			expect(onRenderNeeded).toHaveBeenCalledTimes(1);
		});

		it("triggers render for non-git tools too", () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			lifecycle.onToolEnd("read");
			expect(onRenderNeeded).toHaveBeenCalledTimes(1);
		});
	});

	describe("onUserBash", () => {
		it("schedules git refresh when git handle exists", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock
				.results[0]?.value;

			lifecycle.onUserBash();
			expect(handle.schedule).toHaveBeenCalledTimes(1);
		});

		it("does not throw when git handle is absent", () => {
			const { lifecycle } = createLifecycle();
			expect(() => lifecycle.onUserBash()).not.toThrow();
		});
	});

	// ── Commands ───────────────────────────────────────────

	describe("toggle", () => {
		it("disables and clears git", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock
				.results[0]?.value;

			const enabled = await lifecycle.toggle();
			expect(enabled).toBe(false);
			expect(lifecycle.isEnabled).toBe(false);
			expect(handle.clear).toHaveBeenCalled();
		});

		it("re-enables and creates new git handle", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());

			await lifecycle.toggle(); // off
			await lifecycle.toggle(); // back on
			expect(createGitState).toHaveBeenCalledTimes(2);
		});
	});

	describe("refresh", () => {
		it("refreshes git when active", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock
				.results[0]?.value;

			await lifecycle.refresh();
			expect(handle.refresh).toHaveBeenCalled();
		});

		it("does not throw when git is undefined", async () => {
			const { lifecycle } = createLifecycle();
			await expect(lifecycle.refresh()).resolves.toBeUndefined();
		});
	});

	describe("reload", () => {
		it("reloads config and recreates git", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			expect(createGitState).toHaveBeenCalledTimes(1);

			await lifecycle.reload(makeMockCtx());
			expect(createGitState).toHaveBeenCalledTimes(2);
		});
	});

	// ── getFooterInput ──────────────────────────────────────

	describe("getFooterInput", () => {
		it("assembles FooterInput from context and state", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.modelId).toBe("anthropic/claude-sonnet-4-20250514");
			expect(input.directory).toBe("my-project");
			expect(input.gitBranch).toBe("main");
			expect(input.gitDirtyCount).toBe(0);
			expect(input.contextUsed).toBe(84_000);
			expect(input.contextMax).toBe(200_000);
			expect(input.config).toBeDefined();
			expect(input.totals).toBeDefined();
		});

		it("uses fallback when model is undefined", () => {
			const { lifecycle } = createLifecycle();
			const input = lifecycle.getFooterInput(
				makeMockCtx({
					model: undefined as unknown as ExtensionContext["model"],
				}),
			);
			expect(input.modelId).toBe("no-model");
		});
	});

	// ── Token caching ────────────────────────────────────────

	describe("token caching", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		const expectedTotals = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 };

		it("caches totals when branch length has not changed", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ branchLength: 5 }));

			const first = lifecycle.getFooterInput(makeMockCtx({ branchLength: 5 }));
			const second = lifecycle.getFooterInput(makeMockCtx({ branchLength: 5 }));

			expect(accumulateTotals).toHaveBeenCalledTimes(1);
			expect(first.totals).toEqual(expectedTotals);
			expect(second.totals).toEqual(expectedTotals);
		});

		it("recomputes totals when branch length changes", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ branchLength: 5 }));

			lifecycle.getFooterInput(makeMockCtx({ branchLength: 5 }));
			const second = lifecycle.getFooterInput(makeMockCtx({ branchLength: 8 }));

			expect(accumulateTotals).toHaveBeenCalledTimes(2);
			expect(second.totals).toEqual(expectedTotals);
		});

		it("resets cache after reload", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ branchLength: 5 }));

			lifecycle.getFooterInput(makeMockCtx({ branchLength: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(1);

			await lifecycle.reload(makeMockCtx({ branchLength: 5 }));
			lifecycle.getFooterInput(makeMockCtx({ branchLength: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(2);
		});

		it("resets cache after toggle", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ branchLength: 5 }));

			lifecycle.getFooterInput(makeMockCtx({ branchLength: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(1);

			await lifecycle.toggle(); // off
			await lifecycle.toggle(); // back on
			lifecycle.getFooterInput(makeMockCtx({ branchLength: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(2);
		});

		it("handles zero-length branch", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ branchLength: 0 }));

			const input = lifecycle.getFooterInput(makeMockCtx({ branchLength: 0 }));
			expect(accumulateTotals).not.toHaveBeenCalled();
			expect(input.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		});
	});
});
