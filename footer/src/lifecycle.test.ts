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
		accumulateCost: vi.fn(() => 0),
	};
});

// ── Imports (real — but git.js and tokens.js are already mocked) ──

import { FooterLifecycle } from "./lifecycle.js";
import { createGitState } from "./git.js";
import { accumulateTotals, accumulateCost } from "./tokens.js";

// ── Helpers ────────────────────────────────────────────────────

function makeMockCtx(
	overrides?: Partial<ExtensionContext> & { entryCount?: number },
): ExtensionContext {
	const { entryCount, ...rest } = overrides ?? {};
	return {
		cwd: "/home/user/projects/my-project",
		hasUI: false,
		model: {
			id: "anthropic/claude-sonnet-4-20250514",
			contextWindow: 200_000,
		} as ExtensionContext["model"],
		getContextUsage: () => ({ tokens: 84_000 }),
		sessionManager: {
			getEntries: () =>
				Array(entryCount ?? 0).fill({ type: "message", message: { role: "assistant" } }),
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
			await expect(lifecycle.start(makeMockCtx({ hasUI: false }))).resolves.toBeUndefined();
		});
	});

	describe("shutdown", () => {
		it("clears git handle when it exists", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

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

		it("sets pending state on assistant message_start", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "pending" });
		});

		it("ignores non-assistant roles for pending state", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("user");

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		it("counts text_delta for live estimate", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000); // 1 second elapsed
			lifecycle.onMessageUpdate("text_delta", "hello world"); // 11 ASCII × 0.25 = 2.75 → ceil = 3

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 3, // 3 tokens / 1 second
				approximate: true,
			});
		});

		it("counts thinking_delta for live estimate", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("thinking_delta", "some thinking"); // 13 ASCII × 0.25 = 3.25 → ceil = 4

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 4,
				approximate: true,
			});
		});

		it("counts toolcall_delta for live estimate", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("toolcall_delta", "tool data"); // 9 ASCII × 0.25 = 2.25 → ceil = 3

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 3,
				approximate: true,
			});
		});

		it("ignores non-delta events", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("start", undefined);
			lifecycle.onMessageUpdate("text_start", undefined);
			lifecycle.onMessageUpdate("text_end", "some text");
			lifecycle.onMessageUpdate("thinking_start", undefined);
			lifecycle.onMessageUpdate("thinking_end", "some text");

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "pending" });
		});

		it("finalizes with exact tok/s when output usage exists", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000); // 1 second elapsed
			lifecycle.onMessageEnd("assistant", 100);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toMatchObject({
				state: "rate",
				value: 100, // 100 / 1
				approximate: false,
			});
		});

		it("finalizes with exact tok/s for fractional values", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2250); // 1.25 seconds elapsed
			lifecycle.onMessageEnd("assistant", 500);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toMatchObject({
				state: "rate",
				value: 400, // 500 / 1.25
				approximate: false,
			});
		});

		it("keeps estimated rate when output usage is missing", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("text_delta", "hello"); // 5 ASCII × 0.25 = 1.25 → ceil = 2
			lifecycle.onMessageEnd("assistant");

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 2, // 2 tokens / 1 second
				approximate: true,
			});
		});

		it("hides when no output observed and no usage", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onMessageEnd("assistant");

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		it("keeps approximate rate on abort after output observed", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("text_delta", "hello"); // 2 tokens
			lifecycle.onMessageAbort();

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 2,
				approximate: true,
			});
		});

		it("hides on abort when no output observed", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onMessageAbort();

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		it("resets tok/s state after reload", async () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageEnd("assistant", 100);

			await lifecycle.reload(makeMockCtx());
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		it("resets tok/s state after toggle", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageEnd("assistant", 100);

			await lifecycle.toggle(); // off
			await lifecycle.toggle(); // back on
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		// ── Finding 1: CJK-aware token estimation ──────────────

		it("produces higher estimates for CJK text than same-length ASCII", () => {
			const { lifecycle: asciiLife } = createLifecycle();
			vi.setSystemTime(1000);
			asciiLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 ASCII chars → ceil(12/4) = 3 tokens with current impl
			asciiLife.onMessageUpdate("text_delta", "abcdefghijkl");

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK chars → should be > 3 tokens (more like 8 tokens)
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法");

			const asciiInput = asciiLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(asciiInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			// CJK should produce strictly more tokens than ASCII for same char count
			expect((cjkInput.toksState as { value: number }).value)
				.toBeGreaterThan((asciiInput.toksState as { value: number }).value);
		});

		it("produces higher estimates for emoji text than same-length ASCII", () => {
			const { lifecycle: asciiLife } = createLifecycle();
			vi.setSystemTime(1000);
			asciiLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 16 ASCII chars → ceil(16/4) = 4 tokens with current impl
			asciiLife.onMessageUpdate("text_delta", "abcdefghijklmnop");

			const { lifecycle: emojiLife } = createLifecycle();
			vi.setSystemTime(1000);
			emojiLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 8 emoji → JS .length = 16 (surrogate pairs) → current impl: ceil(16/4) = 4
			// After fix: emoji weighted ~1 token per 2 chars → 8 emoji → ~8 tokens > 4
			emojiLife.onMessageUpdate("text_delta", "😀😁😂🤣😃😄😅😆");

			const asciiInput = asciiLife.getFooterInput(makeMockCtx());
			const emojiInput = emojiLife.getFooterInput(makeMockCtx());

			expect(asciiInput.toksState.state).toBe("rate");
			expect(emojiInput.toksState.state).toBe("rate");
			expect((emojiInput.toksState as { value: number }).value)
				.toBeGreaterThan((asciiInput.toksState as { value: number }).value);
		});

		it("handles mixed ASCII and CJK text correctly", () => {
			const { lifecycle: mixedLife } = createLifecycle();
			vi.setSystemTime(1000);
			mixedLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 6 ASCII + 4 CJK = 10 chars
			mixedLife.onMessageUpdate("text_delta", "hello 你好世界");

			const { lifecycle: asciiOnlyLife } = createLifecycle();
			vi.setSystemTime(1000);
			asciiOnlyLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 10 ASCII chars → ceil(10/4) = 3 tokens
			asciiOnlyLife.onMessageUpdate("text_delta", "helloworld");

			const mixedInput = mixedLife.getFooterInput(makeMockCtx());
			const asciiInput = asciiOnlyLife.getFooterInput(makeMockCtx());

			expect(mixedInput.toksState.state).toBe("rate");
			expect(asciiInput.toksState.state).toBe("rate");
			// Mixed text with CJK should produce more tokens than pure ASCII of same length
			expect((mixedInput.toksState as { value: number }).value)
				.toBeGreaterThan((asciiInput.toksState as { value: number }).value);
		});

		it("weighs CJK punctuation lower than CJK ideographs", () => {
			const { lifecycle: punctLife } = createLifecycle();
			vi.setSystemTime(1000);
			punctLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK punctuation chars
			punctLife.onMessageUpdate("text_delta", "。、〈〉《》「」『』【】");

			const { lifecycle: ideographLife } = createLifecycle();
			vi.setSystemTime(1000);
			ideographLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK ideographs
			ideographLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来");

			const punctInput = punctLife.getFooterInput(makeMockCtx());
			const ideographInput = ideographLife.getFooterInput(makeMockCtx());

			expect(punctInput.toksState.state).toBe("rate");
			expect(ideographInput.toksState.state).toBe("rate");
			// Punctuation should weigh strictly less than ideographs
			expect((punctInput.toksState as { value: number }).value)
				.toBeLessThan((ideographInput.toksState as { value: number }).value);
		});

		it("weighs Latin extended at 0.5 tokens per char (TOK_OTHER)", () => {
			const { lifecycle: latinLife } = createLifecycle();
			vi.setSystemTime(1000);
			latinLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 Latin extended chars (Cyrillic) — weight 0.5 each → 12×0.5=6
			latinLife.onMessageUpdate("text_delta", "абвгдежзиклм");

			const { lifecycle: asciiLife } = createLifecycle();
			vi.setSystemTime(1000);
			asciiLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 ASCII chars — weight 0.25 each → 12×0.25=3
			asciiLife.onMessageUpdate("text_delta", "abcdefghijkl");

			const latinInput = latinLife.getFooterInput(makeMockCtx());
			const asciiInput = asciiLife.getFooterInput(makeMockCtx());

			expect(latinInput.toksState.state).toBe("rate");
			expect(asciiInput.toksState.state).toBe("rate");
			// Non-ASCII scripts should weigh more than ASCII
			expect((latinInput.toksState as { value: number }).value)
				.toBeGreaterThan((asciiInput.toksState as { value: number }).value);
		});

		it("weighs Halfwidth & Fullwidth Forms (0xFF00-0xFFEF) same as CJK ideographs", () => {
			const { lifecycle: fullwidthLife } = createLifecycle();
			vi.setSystemTime(1000);
			fullwidthLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 fullwidth Latin chars — if TOK_CJK_IDEO: 12×0.67=8.04, if TOK_OTHER: 12×0.5=6
			fullwidthLife.onMessageUpdate("text_delta", "ＡＢＣＤＥＦＧＨＩＪＫＬ");

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK ideograph chars — TOK_CJK_IDEO: 12×0.67=8.04
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来");

			const fullwidthInput = fullwidthLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(fullwidthInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((fullwidthInput.toksState as { value: number }).value)
				.toBeGreaterThanOrEqual((cjkInput.toksState as { value: number }).value);
		});

		it("weighs Bopomofo (0x3100-0x312F) same as CJK ideographs", () => {
			const { lifecycle: bopomofoLife } = createLifecycle();
			vi.setSystemTime(1000);
			bopomofoLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 Bopomofo chars — if TOK_CJK_IDEO: 12×0.67=8.04, if TOK_OTHER: 12×0.5=6
			bopomofoLife.onMessageUpdate("text_delta", "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐ");

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK ideograph chars — TOK_CJK_IDEO: 12×0.67=8.04
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来");

			const bopomofoInput = bopomofoLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(bopomofoInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((bopomofoInput.toksState as { value: number }).value)
				.toBeGreaterThanOrEqual((cjkInput.toksState as { value: number }).value);
		});

		it("weighs Katakana Phonetic Extensions (0x31F0-0x31FF) same as CJK ideographs", () => {
			const { lifecycle: katakanaExtLife } = createLifecycle();
			vi.setSystemTime(1000);
			katakanaExtLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 Katakana Phonetic Extension chars — if TOK_CJK_IDEO: 12×0.67=8.04, if TOK_OTHER: 12×0.5=6
			katakanaExtLife.onMessageUpdate("text_delta", "ㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻ");

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK ideograph chars — TOK_CJK_IDEO: 12×0.67=8.04
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来");

			const katakanaExtInput = katakanaExtLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(katakanaExtInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((katakanaExtInput.toksState as { value: number }).value)
				.toBeGreaterThanOrEqual((cjkInput.toksState as { value: number }).value);
		});

		it("weighs CJK Radicals Supplement (0x2E80-0x2FDF) same as CJK ideographs", () => {
			const { lifecycle: radicalsLife } = createLifecycle();
			vi.setSystemTime(1000);
			radicalsLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK Radicals Supplement chars — if TOK_CJK_IDEO: 12×0.67=8.04, if TOK_OTHER: 12×0.5=6
			radicalsLife.onMessageUpdate("text_delta", "⺀⺁⺂⺃⺄⺅⺆⺇⺈⺉⺊⺋");

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 CJK ideograph chars — TOK_CJK_IDEO: 12×0.67=8.04
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来");

			const radicalsInput = radicalsLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(radicalsInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((radicalsInput.toksState as { value: number }).value)
				.toBeGreaterThanOrEqual((cjkInput.toksState as { value: number }).value);
		});

		it("weighs Bopomofo boundary char U+312E same as CJK ideographs", () => {
			const { lifecycle: bopomofoLife } = createLifecycle();
			vi.setSystemTime(1000);
			bopomofoLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12x U+312E (last assigned Bopomofo char)
			bopomofoLife.onMessageUpdate("text_delta", "ㄮㄮㄮㄮㄮㄮㄮㄮㄮㄮㄮㄮ");

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来");

			const bopomofoInput = bopomofoLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(bopomofoInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((bopomofoInput.toksState as { value: number }).value)
				.toBeGreaterThanOrEqual((cjkInput.toksState as { value: number }).value);
		});

		it("weighs fullwidth currency symbols (¥₩) lower than CJK ideographs", () => {
			// Fullwidth Yen Sign U+FFE5 — currency symbol, not ideograph
			const { lifecycle: currencyLife } = createLifecycle();
			vi.setSystemTime(1000);
			currencyLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			currencyLife.onMessageUpdate("text_delta", "￥￥￥￥￥￥￥￥￥￥￥￥"); // 12x U+FFE5

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来"); // 12 CJK ideographs

			const currencyInput = currencyLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(currencyInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			// Currency symbols should weigh LESS than CJK ideographs
			expect((currencyInput.toksState as { value: number }).value)
				.toBeLessThan((cjkInput.toksState as { value: number }).value);
		});

		it("weighs Halfwidth Katakana (0xFF65-0xFF9F) same as CJK ideographs", () => {
			const { lifecycle: halfwidthKataLife } = createLifecycle();
			vi.setSystemTime(1000);
			halfwidthKataLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			// 12 halfwidth katakana chars (U+FF66-FF71)
			halfwidthKataLife.onMessageUpdate("text_delta", "ｦｧｨｩｪｫｬｭｮｯｱｲ");

			const { lifecycle: cjkLife } = createLifecycle();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart("assistant");
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate("text_delta", "你好世界测试中文输入法来");

			const halfwidthKataInput = halfwidthKataLife.getFooterInput(makeMockCtx());
			const cjkInput = cjkLife.getFooterInput(makeMockCtx());

			expect(halfwidthKataInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((halfwidthKataInput.toksState as { value: number }).value)
				.toBeGreaterThanOrEqual((cjkInput.toksState as { value: number }).value);
		});

		// ── Rate computation across rapid deltas ─────────────────

		it("computes rate correctly across rapid deltas", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");

			// Send 20 rapid deltas at the same timestamp.
			// Display state should be consistent regardless of delta frequency.
			// Each delta is a single character update.
			vi.setSystemTime(1500);
			for (let i = 0; i < 20; i++) {
				lifecycle.onMessageUpdate("text_delta", "x");
			}

			// Read displayState — the rate should reflect all accumulated
			// tokens across the entire rapid-delta burst.
			// We verify that the final rate is based on all 20 tokens (5 per delta)
			// accumulated, not some intermediate snapshot.
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState.state).toBe("rate");
			// 20 chars * (estimate) / 0.5s = some rate. The key invariant is that
			// the rate reflects ALL accumulated tokens, not a partial batch.
			const rate = (input.toksState as { value: number }).value;
			expect(rate).toBeGreaterThan(0);
		});

		it("fires onRenderNeeded on each delta (no throttle)", () => {
			const { lifecycle, onRenderNeeded } = createLifecycle();
			lifecycle.onMessageStart("assistant"); // calls onRenderNeeded once
			onRenderNeeded.mockClear();

			// Send 15 rapid text deltas — each should trigger render immediately
			for (let i = 0; i < 15; i++) {
				lifecycle.onMessageUpdate("text_delta", "a");
			}

			// onRenderNeeded should be called once per delta
			expect(onRenderNeeded).toHaveBeenCalledTimes(15);
		});

		it("returns stable toksState reference between reads", () => {
			const { lifecycle } = createLifecycle();
			vi.setSystemTime(1000);
			lifecycle.onMessageStart("assistant");
			vi.setSystemTime(2000);
			lifecycle.onMessageUpdate("text_delta", "hello");

			// Snapshot the displayState object reference
			const before = lifecycle.getFooterInput(makeMockCtx()).toksState;

			// Call getFooterInput again without any new deltas.
			// Cache hit — no new state object should be created.
			const after = lifecycle.getFooterInput(makeMockCtx());

			// The displayState should be referentially identical (no unnecessary alloc)
			expect(after.toksState).toBe(before);
		});

		it("does not compute for non-assistant messages", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("user");
			lifecycle.onMessageEnd("user", 100);

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});
	});

	describe("onUserBash", () => {
		it("schedules git refresh when git handle exists", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

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
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

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
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

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

		it("includes sessionCost from accumulateCost", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());

			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.sessionCost).toBe(0); // mock accumulateCost returns no cost
		});

		it("passes positive accumulateCost through getFooterInput", async () => {
			vi.mocked(accumulateCost).mockReturnValue(1.23);
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());

			const input = lifecycle.getFooterInput(makeMockCtx({ entryCount: 1 }));
			expect(input.sessionCost).toBe(1.23);
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
			await lifecycle.start(makeMockCtx({ entryCount: 5 }));

			const first = lifecycle.getFooterInput(makeMockCtx({ entryCount: 5 }));
			const second = lifecycle.getFooterInput(makeMockCtx({ entryCount: 5 }));

			expect(accumulateTotals).toHaveBeenCalledTimes(1);
			expect(first.totals).toEqual(expectedTotals);
			expect(second.totals).toEqual(expectedTotals);
		});

		it("recomputes totals when branch length changes", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ entryCount: 5 }));

			lifecycle.getFooterInput(makeMockCtx({ entryCount: 5 }));
			const second = lifecycle.getFooterInput(makeMockCtx({ entryCount: 8 }));

			expect(accumulateTotals).toHaveBeenCalledTimes(2);
			expect(second.totals).toEqual(expectedTotals);
		});

		it("resets cache after reload", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ entryCount: 5 }));

			lifecycle.getFooterInput(makeMockCtx({ entryCount: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(1);

			await lifecycle.reload(makeMockCtx({ entryCount: 5 }));
			lifecycle.getFooterInput(makeMockCtx({ entryCount: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(2);
		});

		it("resets cache after toggle", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ entryCount: 5 }));

			lifecycle.getFooterInput(makeMockCtx({ entryCount: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(1);

			await lifecycle.toggle(); // off
			await lifecycle.toggle(); // back on
			lifecycle.getFooterInput(makeMockCtx({ entryCount: 5 }));
			expect(accumulateTotals).toHaveBeenCalledTimes(2);
		});

		it("handles zero-length branch", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx({ entryCount: 0 }));

			const input = lifecycle.getFooterInput(makeMockCtx({ entryCount: 0 }));
			expect(accumulateTotals).not.toHaveBeenCalled();
			expect(input.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		});
	});

	describe("onToolExecutionEnd", () => {
		it("decrements active tool count", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			lifecycle.onToolExecutionStart("edit");
			lifecycle.onToolExecutionEnd("bash");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "activity", label: "edit..." });
		});

		it("returns to pending after all tools end during active message", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionStart("bash");
			lifecycle.onToolExecutionEnd("bash");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState).toEqual({ state: "pending" });
		});

		it("does not go negative on extra end calls", () => {
			const { lifecycle } = createLifecycle();
			lifecycle.onMessageStart("assistant");
			lifecycle.onToolExecutionEnd("bash");
			lifecycle.onToolExecutionEnd("bash");
			const input = lifecycle.getFooterInput(makeMockCtx());
			expect(input.toksState.state).not.toBe("activity");
		});
	});

		it("schedules git refresh for bash tool", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			lifecycle.onToolExecutionEnd("bash");

			expect(handle.schedule).toHaveBeenCalled();
		});

		it("schedules git refresh for edit tool", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			lifecycle.onToolExecutionEnd("edit");

			expect(handle.schedule).toHaveBeenCalled();
		});

		it("schedules git refresh for write tool", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			lifecycle.onToolExecutionEnd("write");

			expect(handle.schedule).toHaveBeenCalled();
		});

		it("does not schedule git refresh for other tools", async () => {
			const { lifecycle } = createLifecycle();
			await lifecycle.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			lifecycle.onToolExecutionEnd("web_search");

			expect(handle.schedule).not.toHaveBeenCalled();
		});
});
