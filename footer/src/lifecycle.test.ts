import { vi, describe, it, expect, beforeEach } from "vitest";
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

// ── Imports (real — but git.js is already mocked) ──────────────

import { FooterLifecycle } from "./lifecycle.js";
import { createGitState } from "./git.js";

// ── Helpers ────────────────────────────────────────────────────

function makeMockCtx(overrides?: Partial<ExtensionContext>): ExtensionContext {
	return {
		cwd: "/home/user/projects/my-project",
		hasUI: false,
		model: {
			id: "anthropic/claude-sonnet-4-20250514",
			contextWindow: 200_000,
		} as ExtensionContext["model"],
		getContextUsage: () => ({ tokens: 84_000 }),
		sessionManager: {
			getBranch: () => [],
		} as unknown as ExtensionContext["sessionManager"],
		ui: {} as ExtensionContext["ui"],
		...overrides,
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
});
