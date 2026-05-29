import { describe, it, expect } from "vitest";
import { renderAsciiLib } from "./ascii-lib.js";
import { ASCII_LIB_FONT, ASCII_LIB_HEIGHT } from "./ascii-lib-font.js";

describe("renderAsciiLib", () => {
	it("renders known uppercase glyphs", () => {
		const result = renderAsciiLib("AB");
		expect(result).toHaveLength(ASCII_LIB_HEIGHT);
		expect(result.join("\n")).toContain(".o.");
		expect(result.join("\n")).toContain("oooooo");
	});

	it("renders lowercase glyphs", () => {
		const result = renderAsciiLib("ab");
		expect(result).toHaveLength(ASCII_LIB_HEIGHT);
		expect(result.some((line) => /\S/.test(line))).toBe(true);
	});

	it("renders digit glyphs", () => {
		const result = renderAsciiLib("01");
		expect(result).toHaveLength(ASCII_LIB_HEIGHT);
		expect(result.join("\n")).toContain("o888");
	});

	it("uses space fallback for unknown characters", () => {
		const withUnknown = renderAsciiLib("A@B");
		const withSpace = renderAsciiLib("A B");
		expect(withUnknown).toEqual(withSpace);
	});

	it("returns blank lines for empty string", () => {
		const result = renderAsciiLib("");
		expect(result).toHaveLength(ASCII_LIB_HEIGHT);
		expect(result.every((line) => line === "")).toBe(true);
	});

	it("accepts explicit font argument", () => {
		const result = renderAsciiLib("Z9", ASCII_LIB_FONT);
		expect(result).toHaveLength(ASCII_LIB_HEIGHT);
	});
});
