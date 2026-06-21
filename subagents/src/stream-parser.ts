import type { AgentState } from "./types.ts";

const ACTIVITY_MAX_CHARS = 80;
const TOOL_ARG_KEYS = [
	"path", "file", "filePath", "file_path", "url",
	"command", "query", "pattern", "name", "id", "title",
] as const;

type AssistantTextPart = { type: "text"; text: string };
type AssistantToolCallPart = { type: "toolCall"; name: string; arguments: unknown };
type AssistantPart = AssistantTextPart | AssistantToolCallPart | { type: string };

export type StreamEvent = { type: string } & Record<string, unknown>;

export type StreamAccumulator = {
	state: AgentState;
	transcript: string;
	activity: string | null;
	stopReason: string | undefined;
	errorMessage: string | undefined;
};

export const createAccumulator = (): StreamAccumulator => ({
	state: "idle",
	transcript: "",
	activity: null,
	stopReason: undefined,
	errorMessage: undefined,
});

export const truncateActivity = (text: string): string =>
	text.length <= ACTIVITY_MAX_CHARS ? text : `${text.slice(0, ACTIVITY_MAX_CHARS - 1)}…`;

export const summarizeToolArguments = (toolArguments: unknown): string => {
	if (!toolArguments || typeof toolArguments !== "object") return "";
	const record = toolArguments as Record<string, unknown>;
	for (const key of TOOL_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
};

export const formatTextSnippet = (text: string): string => {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const trimmed = lines[index]?.replace(/\s+/g, " ").trim() ?? "";
		if (trimmed.length > 0) return truncateActivity(trimmed);
	}
	return "";
};

export const formatToolActivity = (toolName: string, toolArguments: unknown): string => {
	const argumentSummary = summarizeToolArguments(toolArguments);
	return truncateActivity(argumentSummary.length > 0 ? `→ ${toolName}(${argumentSummary})` : `→ ${toolName}`);
};

export const ingestAssistantMessage = (accumulator: StreamAccumulator, raw: unknown): boolean => {
	if (!raw || typeof raw !== "object") return false;
	const record = raw as Record<string, unknown>;
	if (record.role !== "assistant" || !Array.isArray(record.content)) return false;
	const parts = record.content as readonly AssistantPart[];
	let appendedText = "";
	let hasToolCall = false;
	for (const part of parts) {
		if (part.type === "text") appendedText += (part as AssistantTextPart).text;
		else if (part.type === "toolCall") hasToolCall = true;
	}
	let changed = false;
	if (appendedText.length > 0) {
		accumulator.transcript += appendedText;
		changed = true;
		if (!hasToolCall) {
			const snippet = formatTextSnippet(appendedText);
			if (snippet.length > 0) accumulator.activity = snippet;
		}
	}
	if (typeof record.stopReason === "string" && accumulator.stopReason !== record.stopReason) {
		accumulator.stopReason = record.stopReason;
		changed = true;
	}
	if (typeof record.errorMessage === "string" && accumulator.errorMessage !== record.errorMessage) {
		accumulator.errorMessage = record.errorMessage;
		changed = true;
	}
	return changed;
};

export const applyStreamEvent = (accumulator: StreamAccumulator, event: StreamEvent): boolean => {
	switch (event.type) {
		case "message_start": {
			accumulator.errorMessage = undefined;
			accumulator.stopReason = undefined;
			if (accumulator.state === "thinking") return false;
			accumulator.state = "thinking";
			return true;
		}
		case "tool_execution_start": {
			const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
			accumulator.state = "working";
			accumulator.activity = formatToolActivity(toolName, event.args);
			return true;
		}
		case "message_end":
			return ingestAssistantMessage(accumulator, event.message);
		default:
			return false;
	}
};
