import { describe, it, expect } from "vitest";
import { normalizeThinkingLevel } from "./utils.js";

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
