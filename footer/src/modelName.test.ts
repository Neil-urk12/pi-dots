import { describe, it, expect } from "vitest";
import { formatModelName } from "./modelName.js";

const noAliases: Record<string, string> = {};

describe("formatModelName", () => {
	// ── Alias resolution ──────────────────────────────────────

	it("returns alias when full modelId matches", () => {
		const result = formatModelName(
			"anthropic/claude-sonnet-4-20250514",
			{ "anthropic/claude-sonnet-4-20250514": "my-model" },
		);
		expect(result).toBe("my-model");
	});

	it("returns alias when provider-stripped name matches", () => {
		const result = formatModelName(
			"anthropic/claude-sonnet-4-20250514",
			{ "claude-sonnet-4-20250514": "my-sonnet" },
		);
		expect(result).toBe("my-sonnet");
	});

	it("prefers full alias over stripped alias", () => {
		const result = formatModelName(
			"anthropic/claude-sonnet-4-20250514",
			{
				"anthropic/claude-sonnet-4-20250514": "full-match",
				"claude-sonnet-4-20250514": "stripped-match",
			},
		);
		expect(result).toBe("full-match");
	});

	// ── Claude Sonnet family ──────────────────────────────────

	it('shortens "claude-sonnet-4-5-*" to "sonnet-4.5"', () => {
		const result = formatModelName(
			"anthropic/claude-sonnet-4-5-20250514",
			noAliases,
		);
		expect(result).toBe("sonnet-4.5");
	});

	it("shortens sonnet-4.5 variant (dot separator)", () => {
		const result = formatModelName(
			"anthropic/claude-4.5-sonnet-20250514",
			noAliases,
		);
		expect(result).toBe("sonnet-4.5");
	});

	it('shortens "claude-sonnet-4-*" to "sonnet-4"', () => {
		const result = formatModelName(
			"anthropic/claude-sonnet-4-20250514",
			noAliases,
		);
		expect(result).toBe("sonnet-4");
	});

	it("returns 'sonnet' for generic claude sonnet without version", () => {
		const result = formatModelName(
			"anthropic/claude-sonnet-latest",
			noAliases,
		);
		expect(result).toBe("sonnet");
	});

	// ── Claude Opus ───────────────────────────────────────────

	it('shortens claude opus to "opus"', () => {
		const result = formatModelName(
			"anthropic/claude-opus-4-20250514",
			noAliases,
		);
		expect(result).toBe("opus");
	});

	it("does not confuse non-opus claude names", () => {
		const result = formatModelName(
			"anthropic/claude-sonnet-4-20250514",
			noAliases,
		);
		expect(result).not.toBe("opus");
	});

	// ── Claude Haiku ──────────────────────────────────────────

	it('shortens claude haiku to "haiku"', () => {
		const result = formatModelName(
			"anthropic/claude-3-haiku-20240307",
			noAliases,
		);
		expect(result).toBe("haiku");
	});

	// ── GPT family ────────────────────────────────────────────

	it('preserves GPT-5 model string', () => {
		const result = formatModelName(
			"openai/gpt-5-20250501",
			noAliases,
		);
		expect(result).toBe("gpt-5-20250501");
	});

	it('preserves GPT-4 model string', () => {
		const result = formatModelName(
			"openai/gpt-4-turbo-20241201",
			noAliases,
		);
		expect(result).toBe("gpt-4-turbo-20241201");
	});

	it('preserves plain GPT-4 (no suffix)', () => {
		const result = formatModelName(
			"openai/gpt-4",
			noAliases,
		);
		expect(result).toBe("gpt-4");
	});

	// ── Gemini family ─────────────────────────────────────────

	it('strips "-preview" suffix from gemini names', () => {
		const result = formatModelName(
			"google/gemini-2.0-flash-exp-preview",
			noAliases,
		);
		expect(result).toBe("gemini-2.0-flash-exp");
	});

	it('preserves gemini name without preview suffix', () => {
		const result = formatModelName(
			"google/gemini-2.0-flash-001",
			noAliases,
		);
		expect(result).toBe("gemini-2.0-flash-001");
	});

	// ── Truncation ────────────────────────────────────────────

	it("truncates model IDs longer than 24 chars", () => {
		const result = formatModelName(
			"some-very-long-model-name-that-exceeds-twenty-four",
			noAliases,
		);
		expect(result).toBe("some-very-long-model-…");
		expect(result.length).toBe(22); // 21 chars + ellipsis
	});

	it("does not truncate strings at 24 chars or fewer", () => {
		const name = "exactly-24-char-name!!";
		expect(name.length).toBe(22); // sanity check
		const result = formatModelName(name, noAliases);
		expect(result).toBe(name);
	});

	// ── Edge cases ────────────────────────────────────────────

	it("handles empty string", () => {
		const result = formatModelName("", noAliases);
		expect(result).toBe("");
	});

	it("returns unknown model IDs without provider prefix as-is", () => {
		const result = formatModelName("deepseek-v3", noAliases);
		expect(result).toBe("deepseek-v3");
	});

	it("returns unknown model IDs with provider prefix without truncating", () => {
		const result = formatModelName(
			"huggingface/my-awesome-model",
			noAliases,
		);
		expect(result).toBe("my-awesome-model");
	});

	it("does not crash on modelId with only numbers", () => {
		const result = formatModelName("12345", noAliases);
		expect(result).toBe("12345");
	});
});
