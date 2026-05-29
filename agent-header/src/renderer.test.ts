import { describe, it, expect, vi } from "vitest";
import { renderHeader } from "./renderer.js";
import type { HeaderInput, Theme } from "./types.js";
import { defaultConfig } from "./configSchema.js";

// Mock theme
const mockTheme: Theme = {
	fg: vi.fn((_color: string, text: string) => text),
	bold: vi.fn((text: string) => text),
} as unknown as Theme;

describe("renderer", () => {
	const baseInput: HeaderInput = {
		name: "Sci-pi",
		version: "0.1.0",
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

	it("includes version in subtitle", () => {
		const result = renderHeader(baseInput, mockTheme, 80);
		const subtitleLine = result[result.length - 2]; // Before final empty line
		expect(subtitleLine).toContain("v0.1.0");
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
});
