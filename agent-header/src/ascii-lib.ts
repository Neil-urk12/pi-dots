import { ASCII_LIB_FONT, ASCII_LIB_HEIGHT, type AsciiLibFont } from "./ascii-lib-font.js";

/**
 * Render text using glyphs parsed from asciilib.txt.
 * Supports A-Z, a-z, 0-9. Unknown characters fall back to space.
 */
export function renderAsciiLib(text: string, font: AsciiLibFont = ASCII_LIB_FONT): string[] {
	const fallback = font[" "] ?? Array.from({ length: ASCII_LIB_HEIGHT }, () => "");

	if (text.length === 0) {
		return Array.from({ length: ASCII_LIB_HEIGHT }, () => "");
	}

	const glyphs = Array.from(text).map((ch) => font[ch] ?? fallback);
	const lines: string[] = [];

	for (let row = 0; row < ASCII_LIB_HEIGHT; row++) {
		lines.push(glyphs.map((glyph) => glyph[row] ?? "").join(""));
	}

	return lines;
}
