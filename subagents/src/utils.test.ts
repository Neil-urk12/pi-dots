import { describe, it, expect } from "vitest";
import { escapeRegExp, extractTextFromContent } from "./utils";

describe("escapeRegExp", () => {
	it("escapes regex metacharacters", () => {
		expect(escapeRegExp("a.b")).toBe("a\\.b");
		expect(escapeRegExp("a+b")).toBe("a\\+b");
		expect(escapeRegExp("a*b")).toBe("a\\*b");
		expect(escapeRegExp("a?b")).toBe("a\\?b");
		expect(escapeRegExp("a(b)c")).toBe("a\\(b\\)c");
		expect(escapeRegExp("a[0]")).toBe("a\\[0\\]");
		expect(escapeRegExp("a{1}")).toBe("a\\{1\\}");
		expect(escapeRegExp("a|b")).toBe("a\\|b");
		expect(escapeRegExp("a^b")).toBe("a\\^b");
		expect(escapeRegExp("a$b")).toBe("a\\$b");
	});

	it("passes through strings with no special characters", () => {
		expect(escapeRegExp("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
		expect(escapeRegExp("anthropic")).toBe("anthropic");
	});

	it("handles empty string", () => {
		expect(escapeRegExp("")).toBe("");
	});

	it("escapes backslash", () => {
		expect(escapeRegExp("a\\b")).toBe("a\\\\b");
	});

	it("handles string with all metacharacters", () => {
		const input = ".*+?^${}()|[]\\";
		const expected = "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\";
		expect(escapeRegExp(input)).toBe(expected);
	});
});

describe("extractTextFromContent", () => {
	it("returns empty string for null", () => {
		expect(extractTextFromContent(null)).toBe("");
	});

	it("returns empty string for undefined", () => {
		expect(extractTextFromContent(undefined)).toBe("");
	});

	it("returns string content directly", () => {
		expect(extractTextFromContent("hello world")).toBe("hello world");
	});

	it("extracts text from text blocks", () => {
		const content = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		expect(extractTextFromContent(content)).toBe("first\nsecond");
	});

	it("filters out non-text blocks", () => {
		const content = [
			{ type: "text", text: "visible" },
			{ type: "image", url: "img.png" },
			{ type: "text", text: "also visible" },
		];
		expect(extractTextFromContent(content)).toBe("visible\nalso visible");
	});

	it("returns empty string for empty array", () => {
		expect(extractTextFromContent([])).toBe("");
	});

	it("returns empty string for array with no text blocks", () => {
		const content = [
			{ type: "image", url: "img.png" },
			{ type: "tool_use", id: "123" },
		];
		expect(extractTextFromContent(content)).toBe("");
	});

	it("returns empty string for non-string non-array content", () => {
		expect(extractTextFromContent(42)).toBe("");
		expect(extractTextFromContent({})).toBe("");
	});
});
