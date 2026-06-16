import { describe, expect, test } from "bun:test";
import {
	type StreamAccumulator,
	type StreamEvent,
	createAccumulator,
	truncateActivity,
	summarizeToolArguments,
	formatTextSnippet,
	formatToolActivity,
	ingestAssistantMessage,
	applyStreamEvent,
} from "../stream-parser.ts";

// ── truncateActivity ─────────────────────────────────────────────────

describe("truncateActivity", () => {
	test("returns short text unchanged", () => {
		expect(truncateActivity("hello")).toBe("hello");
	});

	test("returns text at exactly the limit unchanged", () => {
		const text = "a".repeat(80);
		expect(truncateActivity(text)).toBe(text);
	});

	test("truncates text exceeding the limit with ellipsis", () => {
		const text = "a".repeat(81);
		const result = truncateActivity(text);
		expect(result.length).toBe(80);
		expect(result).toEndWith("…");
	});

	test("handles empty string", () => {
		expect(truncateActivity("")).toBe("");
	});
});

// ── summarizeToolArguments ────────────────────────────────────────────

describe("summarizeToolArguments", () => {
	test("returns empty for null/undefined", () => {
		expect(summarizeToolArguments(null)).toBe("");
		expect(summarizeToolArguments(undefined)).toBe("");
	});

	test("returns empty for non-object", () => {
		expect(summarizeToolArguments("string")).toBe("");
		expect(summarizeToolArguments(42)).toBe("");
	});

	test("returns empty for object with no matching keys", () => {
		expect(summarizeToolArguments({ foo: "bar" })).toBe("");
	});

	test("extracts 'path' key", () => {
		expect(summarizeToolArguments({ path: "/src/main.ts" })).toBe("/src/main.ts");
	});

	test("extracts 'command' key", () => {
		expect(summarizeToolArguments({ command: "npm test" })).toBe("npm test");
	});

	test("extracts 'query' key", () => {
		expect(summarizeToolArguments({ query: "find bugs" })).toBe("find bugs");
	});

	test("extracts 'url' key", () => {
		expect(summarizeToolArguments({ url: "https://example.com" })).toBe("https://example.com");
	});

	test("skips empty string values", () => {
		expect(summarizeToolArguments({ path: "", command: "ls" })).toBe("ls");
	});

	test("skips non-string values", () => {
		expect(summarizeToolArguments({ path: 42, command: "ls" })).toBe("ls");
	});

	test("respects TOOL_ARG_KEYS priority order — 'path' before 'command'", () => {
		expect(summarizeToolArguments({ path: "/a", command: "b" })).toBe("/a");
	});
});

// ── formatTextSnippet ────────────────────────────────────────────────

describe("formatTextSnippet", () => {
	test("returns last non-empty line trimmed", () => {
		expect(formatTextSnippet("line1\nline2\nline3")).toBe("line3");
	});

	test("collapses internal whitespace", () => {
		expect(formatTextSnippet("  hello   world  ")).toBe("hello world");
	});

	test("skips trailing empty lines", () => {
		expect(formatTextSnippet("content\n\n\n")).toBe("content");
	});

	test("returns empty for all-whitespace input", () => {
		expect(formatTextSnippet("   \n  \n")).toBe("");
	});

	test("returns empty for empty string", () => {
		expect(formatTextSnippet("")).toBe("");
	});

	test("truncates long lines", () => {
		const long = "x".repeat(100);
		const result = formatTextSnippet(long);
		expect(result.length).toBe(80);
		expect(result).toEndWith("…");
	});

	test("handles single line", () => {
		expect(formatTextSnippet("only line")).toBe("only line");
	});
});

// ── formatToolActivity ───────────────────────────────────────────────

describe("formatToolActivity", () => {
	test("formats tool name with argument", () => {
		expect(formatToolActivity("read", { path: "/src/main.ts" })).toBe("→ read(/src/main.ts)");
	});

	test("formats tool name without useful arguments", () => {
		expect(formatToolActivity("bash", {})).toBe("→ bash");
	});

	test("formats tool name with null arguments", () => {
		expect(formatToolActivity("bash", null)).toBe("→ bash");
	});

	test("truncates long argument values", () => {
		const longPath = "/very/long/" + "path/".repeat(20);
		const result = formatToolActivity("read", { path: longPath });
		expect(result.length).toBeLessThanOrEqual(80);
		expect(result).toStartWith("→ read(");
	});
});

// ── ingestAssistantMessage ────────────────────────────────────────────

describe("ingestAssistantMessage", () => {
	test("returns false for null input", () => {
		const acc = createAccumulator();
		expect(ingestAssistantMessage(acc, null)).toBe(false);
	});

	test("returns false for non-object input", () => {
		const acc = createAccumulator();
		expect(ingestAssistantMessage(acc, "string")).toBe(false);
	});

	test("returns false for non-assistant role", () => {
		const acc = createAccumulator();
		expect(ingestAssistantMessage(acc, { role: "user", content: [] })).toBe(false);
	});

	test("returns false for missing content array", () => {
		const acc = createAccumulator();
		expect(ingestAssistantMessage(acc, { role: "assistant" })).toBe(false);
	});

	test("appends text content to transcript", () => {
		const acc = createAccumulator();
		const result = ingestAssistantMessage(acc, {
			role: "assistant",
			content: [{ type: "text", text: "Hello world" }],
		});
		expect(result).toBe(true);
		expect(acc.transcript).toBe("Hello world");
	});

	test("accumulates transcript across multiple calls", () => {
		const acc = createAccumulator();
		ingestAssistantMessage(acc, {
			role: "assistant",
			content: [{ type: "text", text: "Part 1. " }],
		});
		ingestAssistantMessage(acc, {
			role: "assistant",
			content: [{ type: "text", text: "Part 2." }],
		});
		expect(acc.transcript).toBe("Part 1. Part 2.");
	});

	test("sets activity from text snippet when no tool call present", () => {
		const acc = createAccumulator();
		ingestAssistantMessage(acc, {
			role: "assistant",
			content: [{ type: "text", text: "Thinking...\nDone." }],
		});
		expect(acc.activity).toBe("Done.");
	});

	test("does NOT set activity when tool call is present", () => {
		const acc = createAccumulator();
		ingestAssistantMessage(acc, {
			role: "assistant",
			content: [
				{ type: "text", text: "Let me check..." },
				{ type: "toolCall", name: "read", arguments: {} },
			],
		});
		expect(acc.transcript).toBe("Let me check...");
		expect(acc.activity).toBeNull();
	});

	test("captures stopReason", () => {
		const acc = createAccumulator();
		const result = ingestAssistantMessage(acc, {
			role: "assistant",
			content: [{ type: "text", text: "Done" }],
			stopReason: "end_turn",
		});
		expect(result).toBe(true);
		expect(acc.stopReason).toBe("end_turn");
	});

	test("captures errorMessage", () => {
		const acc = createAccumulator();
		const result = ingestAssistantMessage(acc, {
			role: "assistant",
			content: [],
			errorMessage: "rate limited",
		});
		expect(result).toBe(true);
		expect(acc.errorMessage).toBe("rate limited");
	});

	test("returns false when nothing changes", () => {
		const acc = createAccumulator();
		acc.stopReason = "end_turn";
		const result = ingestAssistantMessage(acc, {
			role: "assistant",
			content: [],
			stopReason: "end_turn",
		});
		expect(result).toBe(false);
	});

	test("handles empty content array", () => {
		const acc = createAccumulator();
		const result = ingestAssistantMessage(acc, {
			role: "assistant",
			content: [],
		});
		expect(result).toBe(false);
		expect(acc.transcript).toBe("");
	});
});

// ── applyStreamEvent ─────────────────────────────────────────────────

describe("applyStreamEvent", () => {
	test("returns false for unknown event types", () => {
		const acc = createAccumulator();
		expect(applyStreamEvent(acc, { type: "unknown_event" })).toBe(false);
	});

	test("transitions idle → thinking on message_start", () => {
		const acc = createAccumulator();
		expect(acc.state).toBe("idle");
		const result = applyStreamEvent(acc, { type: "message_start" });
		expect(result).toBe(true);
		expect(acc.state).toBe("thinking");
	});

	test("returns false if already thinking on message_start", () => {
		const acc = createAccumulator();
		acc.state = "thinking";
		expect(applyStreamEvent(acc, { type: "message_start" })).toBe(false);
		expect(acc.state).toBe("thinking");
	});

	test("transitions to working on tool_execution_start", () => {
		const acc = createAccumulator();
		const result = applyStreamEvent(acc, {
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "/src/main.ts" },
		});
		expect(result).toBe(true);
		expect(acc.state).toBe("working");
		expect(acc.activity).toBe("→ read(/src/main.ts)");
	});

	test("uses 'tool' fallback when toolName is missing", () => {
		const acc = createAccumulator();
		applyStreamEvent(acc, { type: "tool_execution_start", args: {} });
		expect(acc.activity).toBe("→ tool");
	});

	test("delegates message_end to ingestAssistantMessage", () => {
		const acc = createAccumulator();
		const result = applyStreamEvent(acc, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Final answer" }],
				stopReason: "end_turn",
			},
		});
		expect(result).toBe(true);
		expect(acc.transcript).toBe("Final answer");
		expect(acc.stopReason).toBe("end_turn");
	});

	test("returns false for message_end with no message field", () => {
		const acc = createAccumulator();
		expect(applyStreamEvent(acc, { type: "message_end" })).toBe(false);
	});
});

// ── createAccumulator ────────────────────────────────────────────────

describe("createAccumulator", () => {
	test("returns correct initial state", () => {
		const acc = createAccumulator();
		expect(acc.state).toBe("idle");
		expect(acc.transcript).toBe("");
		expect(acc.activity).toBeNull();
		expect(acc.stopReason).toBeUndefined();
		expect(acc.errorMessage).toBeUndefined();
	});
});

// ── integration: full event sequence ─────────────────────────────────

describe("integration: full agent lifecycle", () => {
	test("idle → thinking → working → done via sequential events", () => {
		const acc = createAccumulator();

		// Agent starts thinking
		applyStreamEvent(acc, { type: "message_start" });
		expect(acc.state).toBe("thinking");

		// Agent calls a tool
		applyStreamEvent(acc, {
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "/src/main.ts" },
		});
		expect(acc.state).toBe("working");
		expect(acc.activity).toBe("→ read(/src/main.ts)");

		// Agent returns result
		applyStreamEvent(acc, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "File contents here.\nAll looks good." }],
				stopReason: "end_turn",
			},
		});
		expect(acc.state).toBe("working"); // state not changed by message_end
		expect(acc.transcript).toBe("File contents here.\nAll looks good.");
		expect(acc.stopReason).toBe("end_turn");
		expect(acc.activity).toBe("All looks good.");
	});

	test("error event captured via message_end with errorMessage", () => {
		const acc = createAccumulator();
		applyStreamEvent(acc, { type: "message_start" });
		applyStreamEvent(acc, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				errorMessage: "context window exceeded",
			},
		});
		expect(acc.errorMessage).toBe("context window exceeded");
	});
});
