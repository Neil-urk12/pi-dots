import { describe, it, expect } from "vitest";
import type { ColorFn } from "./types.js";
import {
	formatCount,
	formatModelName,
	formatModelSegment,
	formatDirectorySegment,
	formatGitSegment,
	formatTokenSegment,
	formatContextSegment,
} from "./segments.js";
import type { Totals } from "./types.js";

// ── Test helpers ───────────────────────────────────────────────

const dummyColor: ColorFn = (_name, text) => text;

const captureColor: ColorFn = (name, text) => `[${name}:${text}]`;

const zeroTotals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ── formatCount ────────────────────────────────────────────────

describe("formatCount", () => {
	it("returns '0' for zero", () => {
		expect(formatCount(0)).toBe("0");
	});

	it("returns '0' for negative values", () => {
		expect(formatCount(-1)).toBe("0");
		expect(formatCount(-1_000)).toBe("0");
	});

	it("returns '0' for non-finite values", () => {
		expect(formatCount(NaN)).toBe("0");
		expect(formatCount(Infinity)).toBe("0");
		expect(formatCount(-Infinity)).toBe("0");
	});

	it("returns raw number for values under 1k", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(1)).toBe("1");
		expect(formatCount(999)).toBe("999");
	});

	it("rounds to integer for values under 1k", () => {
		expect(formatCount(500.7)).toBe("501");
	});

	it("shows one decimal for values 1k-9,999", () => {
		expect(formatCount(1_000)).toBe("1.0k");
		expect(formatCount(1_500)).toBe("1.5k");
		expect(formatCount(9_999)).toBe("10.0k"); // rounds up to 10.0k
	});

	it("shows integer k for values 10k-999,999", () => {
		expect(formatCount(10_000)).toBe("10k");
		expect(formatCount(10_500)).toBe("11k");
		expect(formatCount(999_999)).toBe("1000k");
	});

	it("shows one decimal m for values ≥1m", () => {
		expect(formatCount(1_000_000)).toBe("1.0m");
		expect(formatCount(1_500_000)).toBe("1.5m");
		expect(formatCount(10_000_000)).toBe("10.0m");
	});
});

// ── formatModelName ────────────────────────────────────────────

describe("formatModelName", () => {
	it("returns the alias when modelId matches exactly", () => {
		const aliases = { "claude-sonnet-4-20250514": "my-sonnet" };
		expect(formatModelName("claude-sonnet-4-20250514", aliases)).toBe(
			"my-sonnet",
		);
	});

	it("returns the alias when provider-stripped name matches", () => {
		const aliases = { "claude-sonnet-4-20250514": "my-sonnet" };
		expect(formatModelName("anthropic/claude-sonnet-4-20250514", aliases)).toBe(
			"my-sonnet",
		);
	});

	it("recognises claude sonnet 4.5 patterns", () => {
		expect(
			formatModelName("anthropic/claude-sonnet-4-5-20250514", {}),
		).toBe("sonnet-4.5");
		expect(
			formatModelName("anthropic/claude-sonnet-4.5-20250514", {}),
		).toBe("sonnet-4.5");
	});

	it("recognises claude sonnet 4", () => {
		expect(formatModelName("anthropic/claude-sonnet-4-20250514", {})).toBe(
			"sonnet-4",
		);
	});

	it("recognises bare sonnet", () => {
		expect(formatModelName("anthropic/claude-sonnet-3-5", {})).toBe("sonnet");
	});

	it("recognises opus", () => {
		expect(formatModelName("anthropic/claude-opus-4", {})).toBe("opus");
	});

	it("recognises haiku", () => {
		expect(formatModelName("anthropic/claude-haiku-3-5", {})).toBe("haiku");
	});

	it("recognises GPT-5 variants", () => {
		expect(formatModelName("openai/gpt-5-20250514", {})).toBe("gpt-5-20250514");
	});

	it("recognises GPT-4 variants (returns base gpt-4)", () => {
		expect(formatModelName("openai/gpt-4o-20250514", {})).toBe("gpt-4");
	});

	it("recognises Gemini models and strips preview suffix", () => {
		expect(formatModelName("google/gemini-2-5-pro-preview-032025", {})).toBe(
			"gemini-2-5-pro",
		);
	});

	it("truncates unknown long model names to 21 chars + ellipsis", () => {
		const long = "a-very-long-model-name-that-exceeds-twenty-four";
		expect(formatModelName(long, {})).toBe("a-very-long-model-nam…");
	});

	it("returns short names unchanged", () => {
		expect(formatModelName("gpt-5", {})).toBe("gpt-5");
	});

	it("prioritises explicit alias over pattern match", () => {
		const aliases = { "claude-sonnet-4-20250514": "custom-sonnet" };
		expect(formatModelName("claude-sonnet-4-20250514", aliases)).toBe(
			"custom-sonnet",
		);
	});
});

// ── formatModelSegment ─────────────────────────────────────────

describe("formatModelSegment", () => {
	it("formats model with no effort", () => {
		const result = formatModelSegment(
			"anthropic/claude-sonnet-4",
			undefined,
			{},
			false,
			dummyColor,
			"accent",
		);
		expect(result).toBe("sonnet-4");
	});

	it("formats model with effort", () => {
		const result = formatModelSegment(
			"anthropic/claude-sonnet-4",
			"high",
			{},
			true,
			captureColor,
			"accent",
		);
		expect(result).toBe("[accent:sonnet-4 • high]");
	});

	it("omits effort when showEffort is false", () => {
		const result = formatModelSegment(
			"anthropic/claude-sonnet-4",
			"high",
			{},
			false,
			captureColor,
			"accent",
		);
		expect(result).toBe("[accent:sonnet-4]");
	});

	it("uses the supplied color", () => {
		const result = formatModelSegment("gpt-5", undefined, {}, false, captureColor, "accent");
		expect(result).toBe("[accent:gpt-5]");
	});

	it("handles undefined thinkingLevel when showEffort is true", () => {
		const result = formatModelSegment("gpt-5", undefined, {}, true, dummyColor, "accent");
		expect(result).toBe("gpt-5");
	});
});

// ── formatDirectorySegment ─────────────────────────────────────

describe("formatDirectorySegment", () => {
	it("formats directory with color", () => {
		expect(formatDirectorySegment("my-project", captureColor, "dim")).toBe(
			"[dim:my-project]",
		);
	});

	it("returns undefined for undefined dir", () => {
		expect(formatDirectorySegment(undefined, dummyColor, "dim")).toBeUndefined();
	});
});

// ── formatGitSegment ───────────────────────────────────────────

describe("formatGitSegment", () => {
	it("returns branch string when clean", () => {
		expect(formatGitSegment("main", 0, captureColor, "success", "warning")).toBe(
			"[success:main]",
		);
	});

	it("appends dirty count when dirty", () => {
		const result = formatGitSegment("main", 3, captureColor, "success", "warning");
		expect(result).toBe("[success:main] [warning:●3]");
	});

	it("returns undefined when branch is undefined", () => {
		expect(
			formatGitSegment(undefined, 0, dummyColor, "success", "warning"),
		).toBeUndefined();
	});

	it("returns branch with zero dirty count", () => {
		expect(formatGitSegment("feature", 0, captureColor, "success", "warning")).toBe(
			"[success:feature]",
		);
	});
});

// ── formatTokenSegment ─────────────────────────────────────────

describe("formatTokenSegment", () => {
	const totals: Totals = { input: 1500, output: 500, cacheRead: 200, cacheWrite: 100 };

	it("returns undefined when showTokens is false", () => {
		expect(
			formatTokenSegment(totals, "full", false, true, dummyColor, "muted"),
		).toBeUndefined();
	});

	it("returns total-only when mode is total-only", () => {
		const result = formatTokenSegment(totals, "total-only", true, true, captureColor, "muted");
		expect(result).toBe("[muted:Σ2.0k]");
	});

	it("returns no-cache when mode is no-cache", () => {
		const result = formatTokenSegment(totals, "no-cache", true, true, captureColor, "muted");
		expect(result).toBe("[muted:↑1.5k ↓500 Σ2.0k]");
	});

	it("returns full with cache when mode is full and showCache is true", () => {
		const result = formatTokenSegment(totals, "full", true, true, captureColor, "muted");
		expect(result).toBe("[muted:↑1.5k ↓500 Σ2.0k ↯200 ↥100]");
	});

	it("falls back to no-cache when showCache is false and mode is full", () => {
		const result = formatTokenSegment(totals, "full", true, false, captureColor, "muted");
		expect(result).toBe("[muted:↑1.5k ↓500 Σ2.0k]");
	});

	it("respects showCache=false for no-cache mode (still no-cache)", () => {
		const result = formatTokenSegment(totals, "no-cache", true, false, captureColor, "muted");
		expect(result).toBe("[muted:↑1.5k ↓500 Σ2.0k]");
	});

	it("handles zero totals", () => {
		const result = formatTokenSegment(zeroTotals, "full", true, true, dummyColor, "muted");
		expect(result).toBe("↑0 ↓0 Σ0 ↯0 ↥0");
	});
});

// ── formatContextSegment ───────────────────────────────────────

describe("formatContextSegment", () => {
	const colors = {
		normal: "success",
		warning: "warning",
		danger: "error",
		dim: "dim",
	};

	it("uses dim when contextMax is missing", () => {
		const result = formatContextSegment(
			50_000,
			undefined,
			70,
			85,
			captureColor,
			colors,
		);
		expect(result).toBe("[dim:ctx 50k/--]");
	});

	it("uses dim when contextMax is falsy (zero treated as unknown)", () => {
		const result = formatContextSegment(0, 0, 70, 85, captureColor, colors);
		expect(result).toBe("[dim:ctx 0/--]");
	});

	it("uses warning when usage is exactly at the warning threshold (>= 70%)", () => {
		const result = formatContextSegment(70_000, 100_000, 70, 85, captureColor, colors);
		expect(result).toBe("[warning:ctx 70k/100k]");
	});

	it("uses warning when usage is between warning and danger threshold", () => {
		const result = formatContextSegment(75_000, 100_000, 70, 85, captureColor, colors);
		expect(result).toBe("[warning:ctx 75k/100k]");
	});

	it("uses danger when usage is at or above danger threshold", () => {
		const result = formatContextSegment(85_000, 100_000, 70, 85, captureColor, colors);
		expect(result).toBe("[error:ctx 85k/100k]");
	});

	it("uses danger when usage exceeds max", () => {
		const result = formatContextSegment(200_000, 100_000, 70, 85, captureColor, colors);
		expect(result).toBe("[error:ctx 200k/100k]");
	});

	it("uses normal when exactly at warning threshold boundary", () => {
		// 69% is still normal (< 70)
		const result = formatContextSegment(69_000, 100_000, 70, 85, captureColor, colors);
		expect(result).toBe("[success:ctx 69k/100k]");
	});
});
