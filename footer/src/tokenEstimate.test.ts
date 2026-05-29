import { describe, it, expect } from "vitest";
import { estimateTokens } from "./tokenEstimate.js";

describe("estimateTokens", () => {
	// ── ASCII (0x20-0x7E): ~0.25 tokens/char ────────────────────

	describe("ASCII characters", () => {
		it("returns 2 for 'hello' (5 chars * 0.25 = 1.25, ceil = 2)", () => {
			expect(estimateTokens("hello")).toBe(2);
		});

		it("returns 25 for 100 ASCII chars (100 * 0.25 = 25)", () => {
			expect(estimateTokens("a".repeat(100))).toBe(25);
		});

		it("handles ASCII digits and symbols", () => {
			// "1234567890" = 10 chars * 0.25 = 2.5, ceil = 3
			expect(estimateTokens("1234567890")).toBe(3);
		});

		it("handles ASCII punctuation and spaces", () => {
			// "hi! @#" = 6 chars * 0.25 = 1.5, ceil = 2
			expect(estimateTokens("hi! @#")).toBe(2);
		});
	});

	// ── CJK Ideographs (~0.67 tokens/char) ─────────────────────

	describe("CJK ideographs", () => {
		it("returns 2 for '你好' (2 chars * 0.67 = 1.34, ceil = 2)", () => {
			expect(estimateTokens("你好")).toBe(2);
		});

		it("handles Hiragana (U+3040-U+309F)", () => {
			// "あいう" = 3 chars * 0.67 = 2.01, ceil = 3
			expect(estimateTokens("あいう")).toBe(3);
		});

		it("handles Katakana (U+30A0-U+30FF)", () => {
			// "アイウ" = 3 chars * 0.67 = 2.01, ceil = 3
			expect(estimateTokens("アイウ")).toBe(3);
		});

		it("handles Hangul (U+AC00-U+D7AF)", () => {
			// "한글" = 2 chars * 0.67 = 1.34, ceil = 2
			expect(estimateTokens("한글")).toBe(2);
		});

		it("handles CJK Extension A (U+3400-U+4DBF)", () => {
			// U+3400 is first Extension A char
			expect(estimateTokens(String.fromCodePoint(0x3400))).toBe(1);
		});

		it("handles CJK Compatibility Ideographs (U+F900-U+FAFF)", () => {
			// U+F900 is first compat ideograph
			expect(estimateTokens(String.fromCodePoint(0xf900))).toBe(1);
		});

		it("handles CJK Radicals Supplement (U+2E80)", () => {
			expect(estimateTokens(String.fromCodePoint(0x2e80))).toBe(1);
		});

		it("handles Kangxi Radicals (U+2FDF)", () => {
			expect(estimateTokens(String.fromCodePoint(0x2fdf))).toBe(1);
		});

		it("handles Bopomofo start (U+3100)", () => {
			expect(estimateTokens(String.fromCodePoint(0x3100))).toBe(1);
		});

		it("handles Bopomofo end boundary (U+312F)", () => {
			expect(estimateTokens(String.fromCodePoint(0x312f))).toBe(1);
		});

		it("handles Katakana Phonetic Extensions (U+31F0-U+31FF)", () => {
			expect(estimateTokens(String.fromCodePoint(0x31f0))).toBe(1);
			expect(estimateTokens(String.fromCodePoint(0x31ff))).toBe(1);
		});

		it("handles Halfwidth Katakana (U+FF65-U+FF9F)", () => {
			expect(estimateTokens(String.fromCodePoint(0xff65))).toBe(1);
			expect(estimateTokens(String.fromCodePoint(0xff9f))).toBe(1);
		});

		it("handles CJK Compatibility Ideographs upper bound (U+FAFF)", () => {
			expect(estimateTokens(String.fromCodePoint(0xfaff))).toBe(1);
		});
	});

	// ── CJK Punctuation (U+3000-U+303F): ~0.5 tokens/char ─────

	describe("CJK punctuation", () => {
		it("returns 1 for '。「' (2 chars * 0.5 = 1)", () => {
			expect(estimateTokens("。「")).toBe(1);
		});

		it("handles full range of CJK punctuation", () => {
			// U+3001 (、), U+3002 (。), U+300C (「), U+300D (」)
			// 4 chars * 0.5 = 2
			expect(estimateTokens("、「」")).toBe(2);
		});
	});

	// ── Non-BMP / Emoji (U+10000+): ~1 token/char ──────────────

	describe("non-BMP emoji", () => {
		it("returns 1 for '😀' (1 emoji * 1 = 1)", () => {
			expect(estimateTokens("😀")).toBe(1);
		});

		it("returns 2 for two emoji", () => {
			expect(estimateTokens("😀🎉")).toBe(2);
		});

		it("handles non-BMP CJK Extension B (U+20000+)", () => {
			// U+20000 first char of Extension B
			expect(estimateTokens(String.fromCodePoint(0x20000))).toBe(1);
		});

		it("treats U+10000 as non-BMP (2 UTF-16 units)", () => {
			expect(estimateTokens(String.fromCodePoint(0x10000))).toBe(1);
		});
	});

	// ── Other characters (~0.5 tokens/char) ────────────────────

	describe("other characters", () => {
		it("handles Latin extended", () => {
			// "éàü" = 3 chars * 0.5 = 1.5, ceil = 2
			expect(estimateTokens("éàü")).toBe(2);
		});

		it("handles Cyrillic", () => {
			// "Привет" = 6 chars * 0.5 = 3
			expect(estimateTokens("Привет")).toBe(3);
		});
	});

	// ── Fullwidth ASCII (U+FF01-U+FF5E): ~0.67 tokens/char ────

	describe("fullwidth ASCII forms", () => {
		it("returns 1 for fullwidth 'Ａ' (1 char * 0.67, ceil = 1)", () => {
			// U+FF21 = fullwidth A
			expect(estimateTokens("Ａ")).toBe(1);
		});

		it("handles fullwidth digits and punctuation", () => {
			// "１２３" = 3 chars * 0.67 = 2.01, ceil = 3
			expect(estimateTokens("１２３")).toBe(3);
		});
	});

	// ── Mixed scripts ──────────────────────────────────────────

	describe("mixed scripts", () => {
		it("returns 3 for 'hello你好' (5*0.25 + 2*0.67 = 2.59, ceil = 3)", () => {
			expect(estimateTokens("hello你好")).toBe(3);
		});

		it("handles ASCII + emoji", () => {
			// "hi!" = 3 * 0.25 = 0.75, "😀" = 1; total = 1.75, ceil = 2
			expect(estimateTokens("hi!😀")).toBe(2);
		});

		it("handles CJK + CJK punctuation", () => {
			// "你好。" = 2 * 0.67 + 1 * 0.5 = 1.84, ceil = 2
			expect(estimateTokens("你好。")).toBe(2);
		});

		it("handles all categories together", () => {
			// "hi" (2*0.25=0.5) + "你好" (2*0.67=1.34) + "。" (1*0.5=0.5) + "🎉" (1*1=1) = 3.34, ceil = 4
			expect(estimateTokens("hi你好。🎉")).toBe(4);
		});
	});

	// ── Edge cases ─────────────────────────────────────────────

	describe("edge cases", () => {
		it("returns 0 for empty string", () => {
			expect(estimateTokens("")).toBe(0);
		});

		it("returns 1 for single ASCII char (1 * 0.25 = 0.25, ceil = 1)", () => {
			expect(estimateTokens("x")).toBe(1);
		});

		it("handles string with only spaces", () => {
			// 3 spaces = 3 * 0.25 = 0.75, ceil = 1
			expect(estimateTokens("   ")).toBe(1);
		});

		it("handles newline and tab as 'other' characters", () => {
			// \n and \t are outside 0x20-0x7E, so 2 * 0.5 = 1
			expect(estimateTokens("\n\t")).toBe(1);
		});
	});
});
