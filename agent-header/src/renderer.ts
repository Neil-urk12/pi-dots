import type { ColorFn, HeaderInput, Theme } from "./types.js";
import { renderAsciiLib } from "./ascii-lib.js";

// ── Pre-rendered ASCII art (special cases) ────────────────────

const ASCII_ART: Record<string, string[]> = {
	"Sci-pi": [
		"  ____       _             _ ",
		" / ___|  ___(_)      _ __ (_)",
		" \\___ \\ / __| |_____| '_ \\| |",
		"  ___) | (__| |_____| |_) | |",
		" |____/ \\___|_|     | .__/|_|",
		"                    |_|      ",
	],
	"Agent-Pi": [
		"      .o.                                            .o           ooooooooo.    o8o",
		"     .888.                                         .o8           `888   `Y88.  `\"'",
		"    .8\"888.      .oooooooo  .ooooo.  ooo. .oo.   .o888oo          888   .d88' oooo",
		"   .8' `888.    888' `88b  d88' `88b `888P\"Y88b    888            888ooo88P'  `888",
		"  .88ooo8888.   888   888  888ooo888  888   888    888   8888888  888          888",
		" .8'     `888.  `88bod8P'  888    .o  888   888    888 .          888          888",
		"o88o     o8888o `8oooooo.  `Y8bod8P' o888o o888o   \"888\"         o888o        o888o",
		"                d\"     YD",
		"                \"Y88888P'"
	],
};


// ── Public interface ─────────────────────────────────────────────

export function renderHeader(input: HeaderInput, theme: Theme, width: number): string[] {
	const cf: ColorFn = (colorName, text) => theme.fg(colorName as never, text);

	const art = getAsciiArt(input.name);
	const subtitle = input.name === "Agent-Pi" ? "" : buildSubtitle(input, cf);

	const result: string[] = [""];

	// Render ASCII art lines as single centered block
	const artWidth = Math.max(0, ...art.map((line) => line.length));
	const artPadding = " ".repeat(Math.max(0, Math.floor((width - artWidth) / 2)));
	for (const line of art) {
		result.push(artPadding + cf(input.config.colors.title, line));
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
	return ASCII_ART[name] ?? renderAsciiLib(name);
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
