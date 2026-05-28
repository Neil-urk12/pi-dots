import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("./git.js", () => {
	const listeners: Array<() => void> = [];
	const fakeRefresh = vi.fn(async () => {
		for (const cb of listeners) cb();
	});
	return {
		createGitState: vi.fn((opts: { onChange?: () => void }) => {
			if (opts.onChange) listeners.push(opts.onChange);
			return {
				state: { inRepo: true, branch: "main", dirtyCount: 0 },
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

vi.mock("./tokens.js", () => ({
	accumulateTotals: vi.fn(() => ({
		input: 100,
		output: 50,
		cacheRead: 10,
		cacheWrite: 5,
	})),
}));

import { FooterLifecycle } from "./lifecycle.js";

function makeMockCtx(
	overrides?: Partial<ExtensionContext> & { branchLength?: number },
): ExtensionContext {
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
			getBranch: () =>
				Array(branchLength ?? 0).fill({ type: "message", msg: { role: "assistant" } }),
		} as unknown as ExtensionContext["sessionManager"],
		ui: {} as ExtensionContext["ui"],
		...rest,
	} as ExtensionContext;
}

function createLifecycle() {
	const onRenderNeeded = vi.fn();
	const lifecycle = new FooterLifecycle({
		globalConfigPath: "/nonexistent/global.json",
		getProjectConfigPath: () => "/nonexistent/project.json",
		getThinkingLevel: () => undefined,
		onRenderNeeded: () => onRenderNeeded(),
	});
	return { lifecycle, onRenderNeeded };
}

describe("tok/s activity states", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("tool execution activity", () => {
		it("sets activity state on tool_execution_start", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "activity", label: "bash..." });
		});

		it("normalizes tool name on start", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("gitnexus_detect_changes");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "activity", label: "nexus..." });
		});

		it("stays in activity state during tool_execution_update", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			lifecycle.onToolExecutionUpdate("bash", "some output");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState.state).toBe("activity");
		});

		it("shows latest tool when multiple tools start", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			lifecycle.onToolExecutionStart("edit");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "activity", label: "edit..." });
		});

		it("returns to pending after tool ends", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			lifecycle.onToolExecutionEnd("bash");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState.state).toBe("pending");
		});
	});

	describe("final rate timeout", () => {
		it("rate has endsAt field after message_end", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("text_delta", "hello");
			lifecycle.onMessageEnd("assistant", 100);
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState.state).toBe("rate");
		});

		it("hides rate after 5 seconds", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("text_delta", "hello");
			lifecycle.onMessageEnd("assistant", 100);

			// Advance past 5 seconds
			vi.advanceTimersByTime(5100);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState.state).toBe("hidden");
		});
	});

	it("stays active when one of two tools ends", () => {
		const { lifecycle } = createLifecycle();
		lifecycle.onMessageStart("assistant");
		lifecycle.onToolExecutionStart("bash");
		lifecycle.onToolExecutionStart("edit");
		lifecycle.onToolExecutionEnd("bash");
		const input = lifecycle.getFooterInput(makeMockCtx());
		expect(input.toksState).toEqual({ state: "activity", label: "edit..." });
	});

	describe("timer lifecycle", () => {
		it("clears timers on shutdown", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			lifecycle.shutdown();
			expect(vi.getTimerCount()).toBe(0);
			// No pending timers should exist
		});

		it("clears timers on toggle disable", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			await lifecycle.toggle(); // off
			// No pending timers should exist
		});
	});
});
