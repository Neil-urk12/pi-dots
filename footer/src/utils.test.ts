import { describe, it, expect } from "vitest";
import { normalizeThinkingLevel, formatCount } from "./utils.js";

describe("normalizeThinkingLevel", () => {
	it("returns undefined for non-string input", () => {
		expect(normalizeThinkingLevel(undefined)).toBeUndefined();
		expect(normalizeThinkingLevel(null)).toBeUndefined();
		expect(normalizeThinkingLevel(42)).toBeUndefined();
		expect(normalizeThinkingLevel({})).toBeUndefined();
	});

	it("normalizes 'medium' to 'med'", () => {
		expect(normalizeThinkingLevel("medium")).toBe("med");
	});

	it("normalizes 'extra-high' to 'xhigh'", () => {
		expect(normalizeThinkingLevel("extra-high")).toBe("xhigh");
	});

	it("normalizes 'extra_high' to 'xhigh'", () => {
		expect(normalizeThinkingLevel("extra_high")).toBe("xhigh");
	});

	it("normalizes 'x-high' to 'xhigh'", () => {
		expect(normalizeThinkingLevel("x-high")).toBe("xhigh");
	});

	it("passes through 'low', 'med', 'high', 'xhigh'", () => {
		expect(normalizeThinkingLevel("low")).toBe("low");
		expect(normalizeThinkingLevel("med")).toBe("med");
		expect(normalizeThinkingLevel("high")).toBe("high");
		expect(normalizeThinkingLevel("xhigh")).toBe("xhigh");
	});

	it("is case-insensitive", () => {
		expect(normalizeThinkingLevel("HIGH")).toBe("high");
		expect(normalizeThinkingLevel("Medium")).toBe("med");
		expect(normalizeThinkingLevel("EXTRA-HIGH")).toBe("xhigh");
	});

	it("returns undefined for unrecognised values", () => {
		expect(normalizeThinkingLevel("unknown")).toBeUndefined();
		expect(normalizeThinkingLevel("max")).toBeUndefined();
		expect(normalizeThinkingLevel("")).toBeUndefined();
	});
});

describe("formatCount", () => {
	// < 1000: raw number
	it("returns raw number for values below 1000", () => {
		expect(formatCount(42)).toBe("42");
		expect(formatCount(1)).toBe("1");
		expect(formatCount(999)).toBe("999");
	});

	// 1000-9999: one decimal
	it("formats 1000-9999 with one decimal and 'k'", () => {
		expect(formatCount(1000)).toBe("1.0k");
		expect(formatCount(1500)).toBe("1.5k");
		expect(formatCount(9999)).toBe("10.0k");
	});

	// 10000-999999: integer k
	it("formats 10000-999999 as integer with 'k'", () => {
		expect(formatCount(10000)).toBe("10k");
		expect(formatCount(15000)).toBe("15k");
		expect(formatCount(999999)).toBe("1000k");
	});

	// >= 1000000: one decimal m
	it("formats >= 1000000 with one decimal and 'm'", () => {
		expect(formatCount(1000000)).toBe("1.0m");
		expect(formatCount(1500000)).toBe("1.5m");
		expect(formatCount(2500000)).toBe("2.5m");
	});

	// zero
	it("returns '0' for zero", () => {
		expect(formatCount(0)).toBe("0");
	});

	// negative
	it("returns '0' for negative values", () => {
		expect(formatCount(-1)).toBe("0");
		expect(formatCount(-500)).toBe("0");
	});

	// NaN
	it("returns '0' for NaN", () => {
		expect(formatCount(NaN)).toBe("0");
	});

	// Infinity
	it("returns '0' for Infinity", () => {
		expect(formatCount(Infinity)).toBe("0");
		expect(formatCount(-Infinity)).toBe("0");
	});
});
