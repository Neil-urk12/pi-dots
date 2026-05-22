import { describe, it, expect } from "vitest";
import {
	formatFullTokens,
	formatNoCacheTokens,
	formatTotalOnlyTokens,
} from "./tokenFormat.js";
import type { Totals, ColorFn } from "./types.js";

const plainCf: ColorFn = (_color, text) => text;

const sampleTotals: Totals = {
	input: 1500,
	output: 500,
	cacheRead: 200,
	cacheWrite: 100,
};

const zeroTotals: Totals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

// ── formatFullTokens ─────────────────────────────────────────

describe("formatFullTokens", () => {
	it("renders input, output, total, cache read, and cache write", () => {
		const result = formatFullTokens(sampleTotals, {
			showCacheRead: true,
			showCacheWrites: true,
			cf: plainCf,
			color: "muted",
		});
		expect(result).toContain("↑1.5k");
		expect(result).toContain("↓500");
		expect(result).toContain("Σ2.0k");
		expect(result).toContain("↯200");
		expect(result).toContain("↥100");
	});

	it("hides cache read when showCacheRead is false", () => {
		const result = formatFullTokens(sampleTotals, {
			showCacheRead: false,
			showCacheWrites: true,
			cf: plainCf,
			color: "muted",
		});
		expect(result).not.toContain("↯");
		expect(result).toContain("↥100");
	});

	it("hides cache write when showCacheWrites is false", () => {
		const result = formatFullTokens(sampleTotals, {
			showCacheRead: true,
			showCacheWrites: false,
			cf: plainCf,
			color: "muted",
		});
		expect(result).toContain("↯200");
		expect(result).not.toContain("↥");
	});

	it("hides both cache indicators when both flags are false", () => {
		const result = formatFullTokens(sampleTotals, {
			showCacheRead: false,
			showCacheWrites: false,
			cf: plainCf,
			color: "muted",
		});
		expect(result).not.toContain("↯");
		expect(result).not.toContain("↥");
		expect(result).toContain("↑1.5k");
		expect(result).toContain("Σ2.0k");
	});

	it("renders zeros for zero totals", () => {
		const result = formatFullTokens(zeroTotals, {
			showCacheRead: true,
			showCacheWrites: true,
			cf: plainCf,
			color: "muted",
		});
		expect(result).toBe("↑0 ↓0 Σ0 ↯0 ↥0");
	});

	it("renders zeros for NaN totals", () => {
		const nanTotals: Totals = {
			input: NaN,
			output: NaN,
			cacheRead: NaN,
			cacheWrite: NaN,
		};
		const result = formatFullTokens(nanTotals, {
			showCacheRead: true,
			showCacheWrites: true,
			cf: plainCf,
			color: "muted",
		});
		expect(result).toContain("↑0");
		expect(result).toContain("↓0");
		expect(result).toContain("Σ0");
	});

	it("renders zeros for Infinity totals", () => {
		const infTotals: Totals = {
			input: Infinity,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		const result = formatFullTokens(infTotals, {
			showCacheRead: true,
			showCacheWrites: false,
			cf: plainCf,
			color: "muted",
		});
		expect(result).toContain("↑0");
	});

	it("applies the color function", () => {
		const colorCf: ColorFn = (color, text) => `[${color}:${text}]`;
		const result = formatFullTokens(sampleTotals, {
			showCacheRead: false,
			showCacheWrites: false,
			cf: colorCf,
			color: "accent",
		});
		expect(result).toMatch(/^\[accent:.*\]$/);
	});
});

// ── formatNoCacheTokens ──────────────────────────────────────

describe("formatNoCacheTokens", () => {
	it("renders input, output, and total without cache indicators", () => {
		const result = formatNoCacheTokens(sampleTotals, plainCf, "muted");
		expect(result).toContain("↑1.5k");
		expect(result).toContain("↓500");
		expect(result).toContain("Σ2.0k");
		expect(result).not.toContain("↯");
		expect(result).not.toContain("↥");
	});

	it("renders zeros for zero totals", () => {
		const result = formatNoCacheTokens(zeroTotals, plainCf, "muted");
		expect(result).toBe("↑0 ↓0 Σ0");
	});

	it("applies the color function", () => {
		const colorCf: ColorFn = (color, text) => `[${color}:${text}]`;
		const result = formatNoCacheTokens(sampleTotals, colorCf, "dim");
		expect(result).toMatch(/^\[dim:.*\]$/);
	});
});

// ── formatTotalOnlyTokens ────────────────────────────────────

describe("formatTotalOnlyTokens", () => {
	it("renders only the total with Σ prefix", () => {
		const result = formatTotalOnlyTokens(sampleTotals, plainCf, "muted");
		expect(result).toBe("Σ2.0k");
	});

	it("does not include input or output indicators", () => {
		const result = formatTotalOnlyTokens(sampleTotals, plainCf, "muted");
		expect(result).not.toContain("↑");
		expect(result).not.toContain("↓");
	});

	it("renders Σ0 for zero totals", () => {
		const result = formatTotalOnlyTokens(zeroTotals, plainCf, "muted");
		expect(result).toBe("Σ0");
	});

	it("applies the color function", () => {
		const colorCf: ColorFn = (color, text) => `[${color}:${text}]`;
		const result = formatTotalOnlyTokens(sampleTotals, colorCf, "accent");
		expect(result).toBe("[accent:Σ2.0k]");
	});
});
