import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createToksActivity } from "./toksActivity.js";

function createActivity() {
	const onRenderNeeded = vi.fn();
	const activity = createToksActivity({ onRenderNeeded });
	return { activity, onRenderNeeded };
}

describe("ToksActivity", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// ── Message lifecycle ───────────────────────────────────

	describe("message_start", () => {
		it("enters pending state", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			expect(activity.getState()).toEqual({ state: "pending" });
		});

		it("stops ends-at timer from previous sample", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "hello");
			activity.onMessageEnd(100);
			expect(activity.getState().state).toBe("rate");

			// New message should reset
			activity.onMessageStart();
			expect(activity.getState()).toEqual({ state: "pending" });
		});

		it("triggers render", () => {
			const { activity, onRenderNeeded } = createActivity();
			activity.onMessageStart();
			expect(onRenderNeeded).toHaveBeenCalledOnce();
		});
	});

	describe("message_update", () => {
		it("counts text_delta for live estimate", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "hello world"); // 11 ASCII × 0.25 = 2.75 → ceil = 3

			expect(activity.getState()).toEqual({
				state: "rate",
				value: 3,
				approximate: true,
			});
		});

		it("counts thinking_delta for live estimate", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("thinking_delta", "some thinking"); // 13 ASCII × 0.25 = 3.25 → ceil = 4

			expect(activity.getState()).toEqual({
				state: "rate",
				value: 4,
				approximate: true,
			});
		});

		it("counts toolcall_delta for live estimate", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("toolcall_delta", "tool data"); // 9 ASCII × 0.25 = 2.25 → ceil = 3

			expect(activity.getState()).toEqual({
				state: "rate",
				value: 3,
				approximate: true,
			});
		});

		it("ignores non-delta events", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("start", undefined);
			activity.onMessageUpdate("text_start", undefined);
			activity.onMessageUpdate("text_end", "some text");
			activity.onMessageUpdate("thinking_start", undefined);
			activity.onMessageUpdate("thinking_end", "some text");

			expect(activity.getState()).toEqual({ state: "pending" });
		});

		it("ignores when no sample exists", () => {
			const { activity, onRenderNeeded } = createActivity();
			onRenderNeeded.mockClear();
			activity.onMessageUpdate("text_delta", "hello");
			expect(onRenderNeeded).not.toHaveBeenCalled();
		});

		it("uses outputTokens when available (not approximate)", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "hello", 50);

			expect(activity.getState()).toEqual({
				state: "rate",
				value: 50, // 50 / 1 second
				approximate: false,
			});
		});

		it("produces higher estimates for CJK text than same-length ASCII", () => {
			const ascii = createActivity();
			vi.setSystemTime(1000);
			ascii.activity.onMessageStart();
			vi.setSystemTime(2000);
			ascii.activity.onMessageUpdate("text_delta", "abcdefghijkl"); // 12 ASCII

			const cjk = createActivity();
			vi.setSystemTime(1000);
			cjk.activity.onMessageStart();
			vi.setSystemTime(2000);
			cjk.activity.onMessageUpdate("text_delta", "你好世界测试中文输入法"); // 12 CJK

			const asciiState = ascii.activity.getState() as { state: "rate"; value: number };
			const cjkState = cjk.activity.getState() as { state: "rate"; value: number };
			expect(asciiState.state).toBe("rate");
			expect(cjkState.state).toBe("rate");
			expect(cjkState.value).toBeGreaterThan(asciiState.value);
		});
	});

	describe("message_end", () => {
		it("finalizes with exact tok/s when output usage exists", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000); // 1 second elapsed
			activity.onMessageEnd(100);

			expect(activity.getState()).toMatchObject({
				state: "rate",
				value: 100, // 100 / 1
				approximate: false,
			});
		});

		it("finalizes with exact tok/s for fractional values", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2250); // 1.25 seconds elapsed
			activity.onMessageEnd(500);

			expect(activity.getState()).toMatchObject({
				state: "rate",
				value: 400, // 500 / 1.25
				approximate: false,
			});
		});

		it("keeps estimated rate when output usage is missing", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "hello"); // 5 ASCII × 0.25 = 1.25 → ceil = 2
			activity.onMessageEnd();

			expect(activity.getState()).toEqual({
				state: "rate",
				value: 2, // 2 tokens / 1 second
				approximate: true,
			});
		});

		it("hides when no output observed and no usage", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onMessageEnd();

			expect(activity.getState()).toEqual({ state: "hidden" });
		});

		it("resets tool count and stops activity timer", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			activity.onToolStart("bash");
			expect(activity.getState().state).toBe("activity");

			vi.setSystemTime(2000);
			activity.onMessageEnd(100);
			// Tool state should be cleared, rate finalized
			expect(activity.getState().state).toBe("rate");
		});

		it("hides rate after 5 seconds", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "hello");
			activity.onMessageEnd(100);

			vi.advanceTimersByTime(5100);
			expect(activity.getState()).toEqual({ state: "hidden" });
		});
	});

	describe("message_abort", () => {
		it("keeps approximate rate after output observed", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "hello"); // 2 tokens
			activity.onMessageAbort();

			expect(activity.getState()).toEqual({
				state: "rate",
				value: 2,
				approximate: true,
			});
		});

		it("hides when no output observed", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onMessageAbort();

			expect(activity.getState()).toEqual({ state: "hidden" });
		});
	});

	// ── Tool activity ───────────────────────────────────────

	describe("tool activity", () => {
		it("enters activity state on tool start", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onToolStart("bash");
			expect(activity.getState()).toEqual({ state: "activity", label: "bash..." });
		});

		it("normalizes tool name on start", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onToolStart("gitnexus_detect_changes");
			expect(activity.getState()).toEqual({ state: "activity", label: "nexus..." });
		});

		it("shows latest tool when multiple tools start", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onToolStart("bash");
			activity.onToolStart("edit");
			expect(activity.getState()).toEqual({ state: "activity", label: "edit..." });
		});

		it("returns to pending after last tool ends", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onToolStart("bash");
			activity.onToolEnd();
			expect(activity.getState().state).toBe("pending");
		});

		it("stays active when one of two tools ends", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onToolStart("bash");
			activity.onToolStart("edit");
			activity.onToolEnd();
			expect(activity.getState()).toEqual({ state: "activity", label: "edit..." });
		});

		it("handles tool end with zero count gracefully", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			// End without start — should not go negative
			activity.onToolEnd();
			expect(activity.getState().state).toBe("pending");
		});

		it("cycles activity dot frames", () => {
			const { activity, onRenderNeeded } = createActivity();
			activity.onMessageStart();
			onRenderNeeded.mockClear();
			activity.onToolStart("bash");
			const callsAfterStart = onRenderNeeded.mock.calls.length;

			vi.advanceTimersByTime(300);
			expect(onRenderNeeded.mock.calls.length).toBeGreaterThan(callsAfterStart);
		});
	});

	// ── Timer lifecycle ─────────────────────────────────────

	describe("timer lifecycle", () => {
		it("clears all timers on shutdown", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onToolStart("bash");
			activity.shutdown();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("clears ends-at timer on shutdown", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "hello");
			activity.onMessageEnd(100);
			activity.shutdown();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("returns hidden state after shutdown", () => {
			const { activity } = createActivity();
			activity.onMessageStart();
			activity.onToolStart("bash");
			activity.shutdown();
			expect(activity.getState()).toEqual({ state: "hidden" });
		});
	});

	// ── Edge cases ──────────────────────────────────────────

	describe("edge cases", () => {
		it("starts in hidden state", () => {
			const { activity } = createActivity();
			expect(activity.getState()).toEqual({ state: "hidden" });
		});

		it("accumulates multiple deltas", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			vi.setSystemTime(2000);
			activity.onMessageUpdate("text_delta", "aaa"); // 3 × 0.25 = 0.75 → ceil = 1
			activity.onMessageUpdate("text_delta", "bbb"); // 3 × 0.25 = 0.75 → ceil = 1, total = 2

			const state = activity.getState() as { state: "rate"; value: number };
			expect(state.state).toBe("rate");
			expect(state.value).toBe(2); // 2 tokens / 1 second
		});

		it("rate stays at 0 elapsed does not crash", () => {
			const { activity } = createActivity();
			vi.setSystemTime(1000);
			activity.onMessageStart();
			// Same timestamp — elapsed = 0
			activity.onMessageUpdate("text_delta", "hello");

			// Should stay pending (elapsed = 0, rate computation skipped)
			expect(activity.getState()).toEqual({ state: "pending" });
		});
	});
});
