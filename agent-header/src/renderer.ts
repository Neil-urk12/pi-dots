import type { ColorFn, HeaderInput, Theme } from "./types.js";

// ── Figlet Standard font for "Sci-pi" ───────────────────────────

const ASCII_ART: Record<string, string[]> = {
	"Sci-pi": [
		"  ____       _             _ ",
		" / ___|  ___(_)      _ __ (_)",
		" \\___ \\ / __| |_____| '_ \\| |",
		"  ___) | (__| |_____| |_) | |",
		" |____/ \\___|_|     | .__/|_|",
		"                    |_|      ",
	],
};


// ── Public interface ─────────────────────────────────────────────

export function renderHeader(input: HeaderInput, theme: Theme, width: number): string[] {
	const cf: ColorFn = (colorName, text) => theme.fg(colorName as never, text);

	const art = getAsciiArt(input.name);
	const subtitle = buildSubtitle(input, cf);

	const result: string[] = [""];

	// Render ASCII art lines
	for (const line of art) {
		result.push(centerLine(cf(input.config.colors.title, line), width));
	}

	// Empty line between art and subtitle
	result.push("");

	// Render subtitle
	if (subtitle) {
		result.push(centerLine(subtitle, width));
	}

	result.push("");

	return result;
}

// ── Private helpers ──────────────────────────────────────────────

function getAsciiArt(name: string): string[] {
	return ASCII_ART[name] ?? ASCII_ART["Sci-pi"];
}

function buildSubtitle(input: HeaderInput, cf: ColorFn): string {
	const parts: string[] = [];


	// Git branch
	if (input.gitBranch) {
		parts.push(input.gitBranch);
	}

	// Directory
	if (input.directory) {
		parts.push(input.directory);
	}

	// Model
	if (input.modelId) {
		parts.push(input.modelId);
	}

	const separator = cf(input.config.colors.separator, " · ");
	return cf(input.config.colors.subtitle, parts.join(separator));
}

function centerLine(line: string, width: number): string {
	// Strip ANSI codes to get visible length
	const visibleLength = line.replace(/\x1b\[[0-9;]*m/g, "").length;
	const padding = Math.max(0, Math.floor((width - visibleLength) / 2));
	return " ".repeat(padding) + line;
}
