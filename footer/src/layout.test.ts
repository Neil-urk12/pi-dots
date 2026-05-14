import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layout, joinLeftRight } from "./layout.js";

// ── layout() ──────────────────────────────────────────────────
//
// Tests use only plain strings — no FooterInput, Theme, or Config.

describe("layout", () => {
	it("joins left and right with separator and space-pads", () => {
		const result = layout(
			["sonnet-4", "my-project"],
			["ctx 84k/200k", "Σ15.5k"],
			" | ",
			100,
		);
		expect(result).toContain("sonnet-4 | my-project");
		expect(result).toContain("ctx 84k/200k | Σ15.5k");
		expect(visibleWidth(result)).toBeLessThanOrEqual(100);
	});

	it("shows only left when right array is empty", () => {
		const result = layout(
			["sonnet-4", "my-project", "main"],
			[],
			" | ",
			60,
		);
		expect(result).toContain("sonnet-4");
		expect(result).toContain("my-project");
		expect(result).toContain("main");
		expect(result).not.toContain("ctx");
	});

	it("shows only right when left array is empty", () => {
		const result = layout(
			[],
			["ctx 84k/200k", "Σ15.5k"],
			" | ",
			60,
		);
		expect(result).toContain("ctx 84k/200k | Σ15.5k");
	});

	it("truncates when width is too narrow for both sides", () => {
		const result = layout(
			["very-long-model-name-that-does-not-fit"],
			["ctx 999k/1m"],
			" | ",
			20,
		);
		expect(visibleWidth(result)).toBeLessThanOrEqual(20);
		expect(result).toContain("very");
		expect(result).toContain("ctx");
	});

	it("handles a single element on each side", () => {
		const result = layout(
			["sonnet-4"],
			["ctx 50k/200k"],
			" | ",
			80,
		);
		expect(result).toContain("sonnet-4");
		expect(result).toContain("ctx 50k/200k");
	});

	it("handles empty arrays on both sides", () => {
		const result = layout([], [], " | ", 80);
		expect(result).toBe("");
	});

	it("filters falsy entries from arrays", () => {
		const result = layout(
			["sonnet-4", "", undefined!, "my-project"],
			["ctx 50k/200k"],
			" | ",
			80,
		);
		expect(result).toContain("sonnet-4 | my-project");
		expect(result).not.toContain("undefined");
	});
});

// ── joinLeftRight() ───────────────────────────────────────────

describe("joinLeftRight", () => {
	it("pads with spaces when both fit", () => {
		const result = joinLeftRight("sonnet-4", "main", 30);
		expect(visibleWidth(result)).toBe(30);
		expect(result).toMatch(/^sonnet-4 +main$/);
	});

	it("returns left-only when right is empty", () => {
		const result = joinLeftRight("sonnet-4", "", 30);
		expect(result).toBe("sonnet-4");
	});

	it("returns right-only when left is empty", () => {
		const result = joinLeftRight("", "ctx 84k/200k", 30);
		expect(result).toBe("ctx 84k/200k");
	});

	it("returns empty when both are empty", () => {
		const result = joinLeftRight("", "", 30);
		expect(result).toBe("");
	});

	it("truncates when total width exceeds available space", () => {
		const result = joinLeftRight("very-long-left-side", "right-side", 25);
		expect(visibleWidth(result)).toBeLessThanOrEqual(25);
		expect(result).toContain("very");
		expect(result).toContain("right");
	});

	it("handles width=1", () => {
		const result = joinLeftRight("abc", "xyz", 1);
		expect(typeof result).toBe("string");
	});
	it("handles width=0", () => {
		const result = joinLeftRight("abc", "xyz", 0);
		expect(typeof result).toBe("string");
	});
});
