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
			// Reset on every handle creation so each test starts with a clean
			// listener list. `vi.clearAllMocks()` only resets call history, not
			// this closure-scoped array.
			listeners.length = 0;
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

import {
	createEventAdapter,
	extractOutputTokens,
	hasUsage,
	type EventAdapter,
} from "./eventAdapter.js";
import { createGitState } from "./git.js";

// ── Helpers ────────────────────────────────────────────────────

type Entry = {
	type: string;
	message?: { role: string; usage?: Record<string, number> & { cost?: { total?: number } } };
};

function makeMockCtx(
	overrides?: Partial<ExtensionContext> & { entries?: Entry[] },
): ExtensionContext {
	const { entries, ...rest } = overrides ?? {};
	return {
		cwd: "/home/user/projects/my-project",
		hasUI: false,
		model: {
			id: "anthropic/claude-sonnet-4-20250514",
			contextWindow: 200_000,
		} as ExtensionContext["model"],
		getContextUsage: () => ({ tokens: 84_000 }),
		sessionManager: {
			getEntries: () => entries ?? [],
		} as unknown as ExtensionContext["sessionManager"],
		ui: {} as ExtensionContext["ui"],
		...rest,
	} as ExtensionContext;
}

function createAdapter(): {
	adapter: EventAdapter;
	onRenderNeeded: ReturnType<typeof vi.fn>;
} {
	const onRenderNeeded = vi.fn();
	const adapter = createEventAdapter({
		globalConfigPath: "/nonexistent/global.json",
		getProjectConfigPath: () => "/nonexistent/project.json",
		getThinkingLevel: () => undefined,
		onRenderNeeded: () => onRenderNeeded(),
	});
	return { adapter, onRenderNeeded };
}

// ── Tests ──────────────────────────────────────────────────────

describe("createEventAdapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ── Construction ─────────────────────────────────────────

	describe("construction", () => {
		it("starts enabled with default config", () => {
			const { adapter } = createAdapter();
			expect(adapter.isEnabled).toBe(true);
			expect(adapter.config.enabled).toBe(true);
			expect(adapter.loadedError).toBeUndefined();
			expect(adapter.loadedPaths).toEqual([]);
		});
	});

	// ── start / shutdown ────────────────────────────────────

	describe("start", () => {
		it("loads config and creates git handle", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());

			expect(createGitState).toHaveBeenCalledTimes(1);
			expect(adapter.loadedError).toBeUndefined();
		});

		it("triggers render via git onChange during start", async () => {
			const { adapter, onRenderNeeded } = createAdapter();
			await adapter.start(makeMockCtx());
			expect(onRenderNeeded).toHaveBeenCalled();
		});

		it("does not crash in non-interactive context", async () => {
			const { adapter } = createAdapter();
			await expect(adapter.start(makeMockCtx({ hasUI: false }))).resolves.toBeUndefined();
		});
	});

	describe("shutdown", () => {
		it("clears git handle when it exists", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			adapter.shutdown();
			expect(handle.clear).toHaveBeenCalledTimes(1);
		});

		it("is safe to call without start", () => {
			const { adapter } = createAdapter();
			expect(() => adapter.shutdown()).not.toThrow();
		});
	});

	// ── Thinking level ──────────────────────────────────────

	describe("onThinkingLevel", () => {
		it("triggers render", () => {
			const { adapter, onRenderNeeded } = createAdapter();
			adapter.onThinkingLevel("high");
			expect(onRenderNeeded).toHaveBeenCalledTimes(1);
		});

		it("accepts all valid levels without error", () => {
			const { adapter } = createAdapter();
			expect(() => {
				adapter.onThinkingLevel("low");
				adapter.onThinkingLevel("medium");
				adapter.onThinkingLevel("med");
				adapter.onThinkingLevel("high");
				adapter.onThinkingLevel("extra-high");
				adapter.onThinkingLevel("xhigh");
			}).not.toThrow();
		});
	});

	describe("onModelSelect", () => {
		it("triggers render", () => {
			const { adapter, onRenderNeeded } = createAdapter();
			adapter.onModelSelect();
			expect(onRenderNeeded).toHaveBeenCalledTimes(1);
		});
	});

	describe("onMessageStart", () => {
		it("accepts assistant role without crash", () => {
			const { adapter } = createAdapter();
			expect(() => adapter.onMessageStart({ role: "assistant" })).not.toThrow();
		});

		it("ignores non-assistant roles", () => {
			const { adapter } = createAdapter();
			expect(() => {
				adapter.onMessageStart({ role: "user" });
				adapter.onMessageStart({ role: "toolResult" });
			}).not.toThrow();
		});
	});

	describe("onMessageUpdate", () => {
		it("extracts delta and forwards for assistant messages", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			expect(() =>
				adapter.onMessageUpdate({
					message: { role: "assistant" },
					assistantMessageEvent: { type: "text_delta", delta: "hello" },
				}),
			).not.toThrow();
		});

		it("ignores non-assistant messages", () => {
			const { adapter, onRenderNeeded } = createAdapter();
			adapter.onMessageUpdate({
				message: { role: "user" },
				assistantMessageEvent: { type: "text_delta", delta: "hi" },
			});
			expect(onRenderNeeded).not.toHaveBeenCalled();
		});

		it("passes undefined delta when streamEvent has no delta key", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			expect(() =>
				adapter.onMessageUpdate({
					message: { role: "assistant" },
					assistantMessageEvent: { type: "start" },
				}),
			).not.toThrow();
		});
	});

	describe("onMessageEnd", () => {
		it("triggers render when role is 'assistant'", () => {
			const { adapter, onRenderNeeded } = createAdapter();
			adapter.onMessageEnd({ role: "assistant" });
			expect(onRenderNeeded).toHaveBeenCalled();
		});

		it("skips render for other roles", () => {
			const { adapter, onRenderNeeded } = createAdapter();
			adapter.onMessageEnd({ role: "user" });
			adapter.onMessageEnd({ role: "system" });
			expect(onRenderNeeded).not.toHaveBeenCalled();
		});
	});

	describe("onUserBash", () => {
		it("schedules git refresh when git handle exists", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			adapter.onUserBash();

			expect(handle.schedule).toHaveBeenCalled();
		});

		it("does not throw when git handle is absent", () => {
			const { adapter } = createAdapter();
			expect(() => adapter.onUserBash()).not.toThrow();
		});
	});

	// ── tok/s computation (ported from lifecycle) ───────────

	describe("tok/s computation", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("sets pending state on assistant message_start", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "pending" });
		});

		it("ignores non-assistant roles for pending state", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "user" });

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		it("counts text_delta for live estimate", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "hello world" },
			});

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 3,
				approximate: true,
			});
		});

		it("counts thinking_delta for live estimate", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_delta", delta: "some thinking" },
			});

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 4,
				approximate: true,
			});
		});

		it("counts toolcall_delta for live estimate", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "toolcall_delta", delta: "tool data" },
			});

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 3,
				approximate: true,
			});
		});

		it("ignores non-delta events", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "start" },
			});
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_start" },
			});
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_end", delta: "some text" },
			});
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_start" },
			});
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "thinking_end", delta: "some text" },
			});

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "pending" });
		});

		it("finalizes with exact tok/s when output usage exists", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageEnd({ role: "assistant", usage: { output: 100 } });

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toMatchObject({
				state: "rate",
				value: 100,
				approximate: false,
			});
		});

		it("finalizes with exact tok/s for fractional values", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2250);
			adapter.onMessageEnd({ role: "assistant", usage: { output: 500 } });

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toMatchObject({
				state: "rate",
				value: 400,
				approximate: false,
			});
		});

		it("keeps estimated rate when output usage is missing", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			});
			adapter.onMessageEnd({ role: "assistant" });

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({
				state: "rate",
				value: 2,
				approximate: true,
			});
		});

		it("hides when no output observed and no usage", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			adapter.onMessageEnd({ role: "assistant" });

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		it("resets tok/s state after reload", async () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageEnd({ role: "assistant", usage: { output: 100 } });

			await adapter.reload(makeMockCtx());
			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		it("resets tok/s state after toggle", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			adapter.onMessageEnd({ role: "assistant", usage: { output: 100 } });

			await adapter.toggle();
			await adapter.toggle();
			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});

		// ── CJK-aware token estimation ──────────────────────

		it("produces higher estimates for CJK text than same-length ASCII", () => {
			const { adapter: asciiLife } = createAdapter();
			vi.setSystemTime(1000);
			asciiLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			asciiLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "abcdefghijkl" },
			});

			const { adapter: cjkLife } = createAdapter();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法" },
			});

			const asciiInput = asciiLife.snapshot(makeMockCtx());
			const cjkInput = cjkLife.snapshot(makeMockCtx());

			expect(asciiInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((cjkInput.toksState as { value: number }).value).toBeGreaterThan(
				(asciiInput.toksState as { value: number }).value,
			);
		});

		it("produces higher estimates for emoji text than same-length ASCII", () => {
			const { adapter: asciiLife } = createAdapter();
			vi.setSystemTime(1000);
			asciiLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			asciiLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "abcdefghijklmnop" },
			});

			const { adapter: emojiLife } = createAdapter();
			vi.setSystemTime(1000);
			emojiLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			emojiLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "😀😁😂🤣😃😄😅😆" },
			});

			const asciiInput = asciiLife.snapshot(makeMockCtx());
			const emojiInput = emojiLife.snapshot(makeMockCtx());

			expect(asciiInput.toksState.state).toBe("rate");
			expect(emojiInput.toksState.state).toBe("rate");
			expect((emojiInput.toksState as { value: number }).value).toBeGreaterThan(
				(asciiInput.toksState as { value: number }).value,
			);
		});

		it("handles mixed ASCII and CJK text correctly", () => {
			const { adapter: mixedLife } = createAdapter();
			vi.setSystemTime(1000);
			mixedLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			mixedLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "hello 你好世界" },
			});

			const { adapter: asciiOnlyLife } = createAdapter();
			vi.setSystemTime(1000);
			asciiOnlyLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			asciiOnlyLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "helloworld" },
			});

			const mixedInput = mixedLife.snapshot(makeMockCtx());
			const asciiInput = asciiOnlyLife.snapshot(makeMockCtx());

			expect(mixedInput.toksState.state).toBe("rate");
			expect(asciiInput.toksState.state).toBe("rate");
			expect((mixedInput.toksState as { value: number }).value).toBeGreaterThan(
				(asciiInput.toksState as { value: number }).value,
			);
		});

		it("weighs CJK punctuation lower than CJK ideographs", () => {
			const { adapter: punctLife } = createAdapter();
			vi.setSystemTime(1000);
			punctLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			punctLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "。、〈〉《》「」『』【】" },
			});

			const { adapter: ideographLife } = createAdapter();
			vi.setSystemTime(1000);
			ideographLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			ideographLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法来" },
			});

			const punctInput = punctLife.snapshot(makeMockCtx());
			const ideographInput = ideographLife.snapshot(makeMockCtx());

			expect(punctInput.toksState.state).toBe("rate");
			expect(ideographInput.toksState.state).toBe("rate");
			expect((punctInput.toksState as { value: number }).value).toBeLessThan(
				(ideographInput.toksState as { value: number }).value,
			);
		});

		it("weighs Latin extended at 0.5 tokens per char", () => {
			const { adapter: latinLife } = createAdapter();
			vi.setSystemTime(1000);
			latinLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			latinLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "абвгдежзиклм" },
			});

			const { adapter: asciiLife } = createAdapter();
			vi.setSystemTime(1000);
			asciiLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			asciiLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "abcdefghijkl" },
			});

			const latinInput = latinLife.snapshot(makeMockCtx());
			const asciiInput = asciiLife.snapshot(makeMockCtx());

			expect(latinInput.toksState.state).toBe("rate");
			expect(asciiInput.toksState.state).toBe("rate");
			expect((latinInput.toksState as { value: number }).value).toBeGreaterThan(
				(asciiInput.toksState as { value: number }).value,
			);
		});

		it("weighs Halfwidth & Fullwidth Forms same as CJK ideographs", () => {
			const { adapter: fullwidthLife } = createAdapter();
			vi.setSystemTime(1000);
			fullwidthLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			fullwidthLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "ＡＢＣＤＥＦＧＨＩＪＫＬ" },
			});

			const { adapter: cjkLife } = createAdapter();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法来" },
			});

			const fullwidthInput = fullwidthLife.snapshot(makeMockCtx());
			const cjkInput = cjkLife.snapshot(makeMockCtx());

			expect(fullwidthInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((fullwidthInput.toksState as { value: number }).value).toBeGreaterThanOrEqual(
				(cjkInput.toksState as { value: number }).value,
			);
		});

		it("weighs Bopomofo same as CJK ideographs", () => {
			const { adapter: bopomofoLife } = createAdapter();
			vi.setSystemTime(1000);
			bopomofoLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			bopomofoLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐ" },
			});

			const { adapter: cjkLife } = createAdapter();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法来" },
			});

			const bopomofoInput = bopomofoLife.snapshot(makeMockCtx());
			const cjkInput = cjkLife.snapshot(makeMockCtx());

			expect(bopomofoInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((bopomofoInput.toksState as { value: number }).value).toBeGreaterThanOrEqual(
				(cjkInput.toksState as { value: number }).value,
			);
		});

		it("weighs Katakana Phonetic Extensions same as CJK ideographs", () => {
			const { adapter: katakanaExtLife } = createAdapter();
			vi.setSystemTime(1000);
			katakanaExtLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			katakanaExtLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "ㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻ" },
			});

			const { adapter: cjkLife } = createAdapter();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法来" },
			});

			const katakanaInput = katakanaExtLife.snapshot(makeMockCtx());
			const cjkInput = cjkLife.snapshot(makeMockCtx());

			expect(katakanaInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((katakanaInput.toksState as { value: number }).value).toBeGreaterThanOrEqual(
				(cjkInput.toksState as { value: number }).value,
			);
		});

		it("weighs CJK Radicals Supplement same as CJK ideographs", () => {
			const { adapter: radicalsLife } = createAdapter();
			vi.setSystemTime(1000);
			radicalsLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			radicalsLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: {
					type: "text_delta",
					delta: "⺀⺁⺂⺃⺄⺅⺆⺇⺈⺉⺊⺋",
				},
			});

			const { adapter: cjkLife } = createAdapter();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法来" },
			});

			const radicalsInput = radicalsLife.snapshot(makeMockCtx());
			const cjkInput = cjkLife.snapshot(makeMockCtx());

			expect(radicalsInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((radicalsInput.toksState as { value: number }).value).toBeGreaterThanOrEqual(
				(cjkInput.toksState as { value: number }).value,
			);
		});

		it("weighs Bopomofo boundary char same as CJK ideographs", () => {
			const { adapter: boundaryLife } = createAdapter();
			vi.setSystemTime(1000);
			boundaryLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			boundaryLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "ㄮ" },
			});

			const input = boundaryLife.snapshot(makeMockCtx());
			expect(input.toksState.state).toBe("rate");
		});

		it("weighs fullwidth currency symbols lower than CJK ideographs", () => {
			const { adapter: currencyLife } = createAdapter();
			vi.setSystemTime(1000);
			currencyLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			currencyLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "￥￦" },
			});

			const input = currencyLife.snapshot(makeMockCtx());
			expect(input.toksState.state).toBe("rate");
			const { adapter: ideographLife } = createAdapter();
			vi.setSystemTime(1000);
			ideographLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			ideographLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法来" },
			});
			const ideographInput = ideographLife.snapshot(makeMockCtx());
			expect((input.toksState as { value: number }).value).toBeLessThan(
				(ideographInput.toksState as { value: number }).value,
			);
		});

		it("weighs Halfwidth Katakana same as CJK ideographs", () => {
			const { adapter: halfwidthLife } = createAdapter();
			vi.setSystemTime(1000);
			halfwidthLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			halfwidthLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "ｱｲｳｴｵｶｷｸｹｺｻｼ" },
			});

			const { adapter: cjkLife } = createAdapter();
			vi.setSystemTime(1000);
			cjkLife.onMessageStart({ role: "assistant" });
			vi.setSystemTime(2000);
			cjkLife.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "你好世界测试中文输入法来" },
			});

			const halfwidthInput = halfwidthLife.snapshot(makeMockCtx());
			const cjkInput = cjkLife.snapshot(makeMockCtx());

			expect(halfwidthInput.toksState.state).toBe("rate");
			expect(cjkInput.toksState.state).toBe("rate");
			expect((halfwidthInput.toksState as { value: number }).value).toBeGreaterThanOrEqual(
				(cjkInput.toksState as { value: number }).value,
			);
		});

		it("computes rate correctly across rapid deltas", () => {
			const { adapter } = createAdapter();
			vi.setSystemTime(1000);
			adapter.onMessageStart({ role: "assistant" });
			vi.setSystemTime(1100);
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "abcde" },
			});
			vi.setSystemTime(1200);
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "fghij" },
			});
			vi.setSystemTime(2000);

			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState.state).toBe("rate");
			// 10 ASCII chars → 2.5 → ceil = 3, /1s elapsed = 3
			expect((input.toksState as { value: number }).value).toBeGreaterThanOrEqual(3);
		});

		it("fires onRenderNeeded on each delta (no throttle)", () => {
			const { adapter, onRenderNeeded } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			onRenderNeeded.mockClear();
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "a" },
			});
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "b" },
			});
			expect(onRenderNeeded.mock.calls.length).toBeGreaterThanOrEqual(2);
		});

		it("returns stable toksState reference between reads", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			adapter.onMessageUpdate({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			});

			const a = adapter.snapshot(makeMockCtx()).toksState;
			const b = adapter.snapshot(makeMockCtx()).toksState;
			expect(a).toEqual(b);
		});

		it("does not compute for non-assistant messages", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "user" });
			adapter.onMessageUpdate({
				message: { role: "user" },
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			});
			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "hidden" });
		});
	});

	// ── Commands ───────────────────────────────────────────

	describe("toggle", () => {
		it("disables and clears git", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			const enabled = await adapter.toggle();
			expect(enabled).toBe(false);
			expect(adapter.isEnabled).toBe(false);
			expect(handle.clear).toHaveBeenCalled();
		});

		it("re-enables and creates new git handle", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());

			await adapter.toggle();
			await adapter.toggle();
			expect(createGitState).toHaveBeenCalledTimes(2);
		});
	});

	describe("refresh", () => {
		it("refreshes git when active", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;

			await adapter.refresh();
			expect(handle.refresh).toHaveBeenCalled();
		});

		it("does not throw when git is undefined", async () => {
			const { adapter } = createAdapter();
			await expect(adapter.refresh()).resolves.toBeUndefined();
		});
	});

	describe("reload", () => {
		it("reloads config and recreates git", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			expect(createGitState).toHaveBeenCalledTimes(1);

			await adapter.reload(makeMockCtx());
			expect(createGitState).toHaveBeenCalledTimes(2);
		});
	});

	// ── snapshot ───────────────────────────────────────────

	describe("snapshot", () => {
		it("assembles FooterInput from context and state", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());

			const input = adapter.snapshot(makeMockCtx());
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
			const { adapter } = createAdapter();
			const input = adapter.snapshot(
				makeMockCtx({ model: undefined as unknown as ExtensionContext["model"] }),
			);
			expect(input.modelId).toBe("no-model");
		});

		it("returns correct directory even before start()", () => {
			const { adapter } = createAdapter();
			const input = adapter.snapshot(makeMockCtx({ cwd: "/home/user/my-project" }));
			expect(input.directory).toBe("my-project");
		});

		it("returns zero totals for empty session", () => {
			const { adapter } = createAdapter();
			const input = adapter.snapshot(makeMockCtx({ entries: [] }));
			expect(input.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(input.sessionCost).toBe(0);
		});

		it("sums totals from assistant messages", () => {
			const { adapter } = createAdapter();
			const entries: Entry[] = [
				{ type: "message", message: { role: "assistant", usage: { input: 10, output: 5 } } },
				{ type: "message", message: { role: "assistant", usage: { input: 20, output: 10 } } },
				{ type: "message", message: { role: "user" } },
			];
			const input = adapter.snapshot(makeMockCtx({ entries }));
			expect(input.totals).toEqual({ input: 30, output: 15, cacheRead: 0, cacheWrite: 0 });
		});

		it("sums cache and cost from assistant messages", () => {
			const { adapter } = createAdapter();
			const entries: Entry[] = [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.5 } },
					},
				},
				{
					type: "message",
					message: {
						role: "assistant",
						usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0.25 } },
					},
				},
			];
			const input = adapter.snapshot(makeMockCtx({ entries }));
			expect(input.totals).toEqual({ input: 20, output: 10, cacheRead: 5, cacheWrite: 3 });
			expect(input.sessionCost).toBeCloseTo(0.75);
		});

		it("ignores zero/negative cost", () => {
			const { adapter } = createAdapter();
			const entries: Entry[] = [
				{ type: "message", message: { role: "assistant", usage: { output: 1, cost: { total: 0 } } } },
				{ type: "message", message: { role: "assistant", usage: { output: 1, cost: { total: -1 } } } },
			];
			const input = adapter.snapshot(makeMockCtx({ entries }));
			expect(input.sessionCost).toBe(0);
		});
	});

	// ── Token caching ────────────────────────────────────────

	describe("token caching", () => {
		const entries: Entry[] = Array(5).fill({
			type: "message",
			message: { role: "assistant", usage: { input: 20, output: 10, cacheRead: 2, cacheWrite: 1 } },
		});

		it("caches totals when entry length has not changed", () => {
			const { adapter } = createAdapter();
			const first = adapter.snapshot(makeMockCtx({ entries }));
			const second = adapter.snapshot(makeMockCtx({ entries }));
			expect(first.totals).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
			expect(second.totals).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
		});

		it("recomputes totals when entry length changes", () => {
			const { adapter } = createAdapter();
			adapter.snapshot(makeMockCtx({ entries }));
			const longer: Entry[] = Array(8).fill({
				type: "message",
				message: { role: "assistant", usage: { input: 20, output: 10, cacheRead: 2, cacheWrite: 1 } },
			});
			const second = adapter.snapshot(makeMockCtx({ entries: longer }));
			expect(second.totals).toEqual({ input: 160, output: 80, cacheRead: 16, cacheWrite: 8 });
		});

		it("resets cache after reload", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx({ entries }));
			adapter.snapshot(makeMockCtx({ entries }));
			await adapter.reload(makeMockCtx({ entries }));
			// After reload, cache is reset; first snapshot recomputes and returns same totals.
			const after = adapter.snapshot(makeMockCtx({ entries }));
			expect(after.totals).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
		});

		it("resets cache after toggle", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx({ entries }));
			adapter.snapshot(makeMockCtx({ entries }));
			await adapter.toggle();
			await adapter.toggle();
			const after = adapter.snapshot(makeMockCtx({ entries }));
			expect(after.totals).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
		});

		it("handles zero-length session", () => {
			const { adapter } = createAdapter();
			const input = adapter.snapshot(makeMockCtx({ entries: [] }));
			expect(input.totals).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		});
	});

	// ── Tool execution ──────────────────────────────────────

	describe("onToolExecutionEnd", () => {
		it("decrements active tool count", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			adapter.onToolExecutionStart({ toolName: "bash" });
			adapter.onToolExecutionStart({ toolName: "edit" });
			adapter.onToolExecutionEnd({ toolName: "bash" });
			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "activity", label: "edit..." });
		});

		it("returns to pending after all tools end during active message", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			adapter.onToolExecutionStart({ toolName: "bash" });
			adapter.onToolExecutionEnd({ toolName: "bash" });
			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState).toEqual({ state: "pending" });
		});

		it("does not go negative on extra end calls", () => {
			const { adapter } = createAdapter();
			adapter.onMessageStart({ role: "assistant" });
			adapter.onToolExecutionEnd({ toolName: "bash" });
			adapter.onToolExecutionEnd({ toolName: "bash" });
			const input = adapter.snapshot(makeMockCtx());
			expect(input.toksState.state).not.toBe("activity");
		});
	});

	describe("git refresh scheduling", () => {
		it("schedules git refresh for bash tool", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;
			adapter.onToolExecutionEnd({ toolName: "bash" });
			expect(handle.schedule).toHaveBeenCalled();
		});

		it("schedules git refresh for edit tool", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;
			adapter.onToolExecutionEnd({ toolName: "edit" });
			expect(handle.schedule).toHaveBeenCalled();
		});

		it("schedules git refresh for write tool", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;
			adapter.onToolExecutionEnd({ toolName: "write" });
			expect(handle.schedule).toHaveBeenCalled();
		});

		it("does not schedule git refresh for other tools", async () => {
			const { adapter } = createAdapter();
			await adapter.start(makeMockCtx());
			const handle = (createGitState as ReturnType<typeof vi.fn>).mock.results[0]?.value;
			adapter.onToolExecutionEnd({ toolName: "web_search" });
			expect(handle.schedule).not.toHaveBeenCalled();
		});
	});
});

describe("hasUsage", () => {
	it("returns true for object with usage as non-null object", () => {
		expect(hasUsage({ usage: { output: 1 } })).toBe(true);
	});

	it("returns true for nested message.usage object", () => {
		expect(hasUsage({ usage: {} })).toBe(true);
	});

	it("returns false for null", () => {
		expect(hasUsage(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(hasUsage(undefined)).toBe(false);
	});

	it("returns false for usage undefined", () => {
		expect(hasUsage({ usage: undefined })).toBe(false);
	});

	it("returns false for usage null", () => {
		expect(hasUsage({ usage: null })).toBe(false);
	});

	it("returns false for usage as primitive", () => {
		expect(hasUsage({ usage: 42 })).toBe(false);
	});

	it("returns false for no usage property", () => {
		expect(hasUsage({})).toBe(false);
	});

	it("returns false for non-object", () => {
		expect(hasUsage("string")).toBe(false);
	});
});

describe("extractOutputTokens", () => {
	it("extracts from top-level usage", () => {
		expect(extractOutputTokens({ usage: { output: 150 } })).toBe(150);
	});

	it("extracts from nested message.usage", () => {
		expect(extractOutputTokens({ message: { usage: { output: 200 } } })).toBe(200);
	});

	it("returns 0 when output is exactly 0", () => {
		expect(extractOutputTokens({ usage: { output: 0 } })).toBe(0);
	});

	it("returns 0 from nested message.usage when output is 0", () => {
		expect(extractOutputTokens({ message: { usage: { output: 0 } } })).toBe(0);
	});

	it("returns undefined for empty usage object", () => {
		expect(extractOutputTokens({ usage: {} })).toBeUndefined();
	});

	it("returns undefined when usage is undefined", () => {
		expect(extractOutputTokens({ usage: undefined })).toBeUndefined();
	});

	it("returns undefined for object with no usage", () => {
		expect(extractOutputTokens({})).toBeUndefined();
	});

	it("returns undefined for null", () => {
		expect(extractOutputTokens(null)).toBeUndefined();
	});

	it("returns undefined for undefined", () => {
		expect(extractOutputTokens(undefined)).toBeUndefined();
	});

	it("returns undefined for negative output", () => {
		expect(extractOutputTokens({ usage: { output: -1 } })).toBeUndefined();
	});

	it("returns fractional tokens", () => {
		expect(extractOutputTokens({ usage: { output: 3.7 } })).toBe(3.7);
	});

	it("prefers top-level usage over nested message.usage", () => {
		expect(
			extractOutputTokens({
				message: { usage: { output: 50 } },
				usage: { output: 100 },
			}),
		).toBe(100);
	});

	it("returns undefined for Infinity output", () => {
		expect(extractOutputTokens({ usage: { output: Infinity } })).toBeUndefined();
	});

	it("returns undefined for NaN output", () => {
		expect(extractOutputTokens({ usage: { output: NaN } })).toBeUndefined();
	});

	it("returns undefined for string output", () => {
		expect(extractOutputTokens({ usage: { output: "150" } })).toBeUndefined();
	});
});
