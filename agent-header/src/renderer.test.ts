import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHeader } from "./renderer.js";
import type { HeaderInput, Theme } from "./types.js";
import { defaultConfig } from "./configSchema.js";

// Mock theme
const mockTheme: Theme = {
	fg: vi.fn((_color: string, text: string) => text),
	bold: vi.fn((text: string) => text),
} as unknown as Theme;

beforeEach(() => {
	vi.clearAllMocks();
});
describe("renderer", () => {
	const baseInput: HeaderInput = {
		name: "Sci-pi",
		modelId: "claude-sonnet-4",
		directory: "my-project",
		config: defaultConfig,
	};

	it("returns array of strings", () => {
		const result = renderHeader(baseInput, mockTheme, 80);
		expect(Array.isArray(result)).toBe(true);
		expect(result.length).toBeGreaterThan(0);
	});

	it("includes ASCII art lines", () => {
		const result = renderHeader(baseInput, mockTheme, 80);
		// Should have empty line, 6 art lines, empty line, subtitle, empty line
		expect(result.length).toBeGreaterThanOrEqual(9);
	});

	it("centers content", () => {
		const result = renderHeader(baseInput, mockTheme, 100);
		// First non-empty line should have leading spaces
		const firstArtLine = result[1]; // After initial empty line
		expect(firstArtLine.startsWith(" ")).toBe(true);
	});


	it("includes git branch when provided", () => {
		const input = { ...baseInput, gitBranch: "main" };
		const result = renderHeader(input, mockTheme, 80);
		const subtitleLine = result[result.length - 2];
		expect(subtitleLine).toContain("main");
	});

	it("excludes git branch when not provided", () => {
		const input = { ...baseInput, gitBranch: undefined };
		const result = renderHeader(input, mockTheme, 80);
		const subtitleLine = result[result.length - 2];
		expect(subtitleLine).not.toContain("main");
	});

	it("includes model in subtitle", () => {
		const result = renderHeader(baseInput, mockTheme, 80);
		const subtitleLine = result[result.length - 2];
		expect(subtitleLine).toContain("claude-sonnet-4");
	});

	it("includes directory in subtitle", () => {
		const result = renderHeader(baseInput, mockTheme, 80);
		const subtitleLine = result[result.length - 2];
		expect(subtitleLine).toContain("my-project");
	});

	it("handles narrow width", () => {
		const result = renderHeader(baseInput, mockTheme, 30);
		expect(Array.isArray(result)).toBe(true);
		// Should still render, even if truncated
	});

	it("uses theme.fg for colors", () => {
		renderHeader(baseInput, mockTheme, 80);
		expect(mockTheme.fg).toHaveBeenCalled();
	});

	it("renders dynamic ASCII lib art for unknown name", () => {
		const input: HeaderInput = { ...baseInput, name: "my-app" };
		const result = renderHeader(input, mockTheme, 80);
		const artLines = result.slice(1, 11);
		const artText = artLines.join("\n");
		expect(artLines.some((line) => /\S/.test(line))).toBe(true);
		expect(artText).not.toContain("  ____       _"); // Not Sci-pi art
	});

	it("Agent-Pi art matches asciilib target", () => {
		const input: HeaderInput = { ...baseInput, name: "Agent-Pi" };
		const result = renderHeader(input, mockTheme, 0);
		expect(result.slice(1, 10)).toEqual([
			"      .o.                                            .o           ooooooooo.    o8o",
			"     .888.                                         .o8           `888   `Y88.  `\"'",
			"    .8\"888.      .oooooooo  .ooooo.  ooo. .oo.   .o888oo          888   .d88' oooo",
			"   .8' `888.    888' `88b  d88' `88b `888P\"Y88b    888            888ooo88P'  `888",
			"  .88ooo8888.   888   888  888ooo888  888   888    888   8888888  888          888",
			" .8'     `888.  `88bod8P'  888    .o  888   888    888 .          888          888",
			"o88o     o8888o `8oooooo.  `Y8bod8P' o888o o888o   \"888\"         o888o        o888o",
			"                d\"     YD",
			"                \"Y88888P'",
		]);
		expect(result.join("\n")).not.toContain("claude-sonnet-4");
	});

	it("handles empty name with blank ASCII lib output", () => {
		const input: HeaderInput = { ...baseInput, name: "" };
		const result = renderHeader(input, mockTheme, 80);
		// Empty name renders blank dynamic ASCII art lines
		expect(result.length).toBeGreaterThanOrEqual(9);
		const artLines = result.slice(1, 11);
		expect(artLines.every((line) => line.trim() === "")).toBe(true);
	});

	it("handles width 0 without crashing", () => {
		const result = renderHeader(baseInput, mockTheme, 0);
		expect(Array.isArray(result)).toBe(true);
	});

	it("handles empty modelId", () => {
		const input: HeaderInput = { ...baseInput, modelId: "" };
		const result = renderHeader(input, mockTheme, 80);
		expect(result.join("\n")).not.toContain("claude-sonnet-4");
	});

	it("subtitle does not contain version string", () => {
		const result = renderHeader(baseInput, mockTheme, 80);
		const subtitleLine = result[result.length - 2];
		// Version is dead code in the rendering path — should never appear in subtitle
		expect(subtitleLine).not.toMatch(/\d+\.\d+\.\d+/);
	});
});
