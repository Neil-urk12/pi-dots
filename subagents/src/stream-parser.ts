import type { AgentState, AgentRun } from "./types.ts";
import { type ProcessHandle } from "./process.ts";

const ACTIVITY_MAX_CHARS = 80;
const TOOL_ARG_KEYS = [
	"path", "file", "filePath", "file_path", "url",
	"command", "query", "pattern", "name", "id", "title",
] as const;

type AssistantTextPart = { type: "text"; text: string };
type AssistantToolCallPart = { type: "toolCall"; name: string; arguments: unknown };
type AssistantPart = AssistantTextPart | AssistantToolCallPart | { type: string };

export type StreamEvent = { type: string } & Record<string, unknown>;

type StreamAccumulator = {
	state: AgentState;
	transcript: string;
	activity: string | null;
	stopReason: string | undefined;
	errorMessage: string | undefined;
};

const createAccumulator = (): StreamAccumulator => ({
	state: "idle",
	transcript: "",
	activity: null,
	stopReason: undefined,
	errorMessage: undefined,
});

const truncateActivity = (text: string): string =>
	text.length <= ACTIVITY_MAX_CHARS ? text : `${text.slice(0, ACTIVITY_MAX_CHARS - 1)}…`;

const summarizeToolArguments = (toolArguments: unknown): string => {
	if (!toolArguments || typeof toolArguments !== "object") return "";
	const record = toolArguments as Record<string, unknown>;
	for (const key of TOOL_ARG_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return "";
};

const formatTextSnippet = (text: string): string => {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const trimmed = lines[index]?.replace(/\s+/g, " ").trim() ?? "";
		if (trimmed.length > 0) return truncateActivity(trimmed);
	}
	return "";
};

const formatToolActivity = (toolName: string, toolArguments: unknown): string => {
	const argumentSummary = summarizeToolArguments(toolArguments);
	return truncateActivity(argumentSummary.length > 0 ? `→ ${toolName}(${argumentSummary})` : `→ ${toolName}`);
};

const ingestAssistantMessage = (accumulator: StreamAccumulator, raw: unknown): boolean => {
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

const applyStreamEvent = (accumulator: StreamAccumulator, event: StreamEvent): boolean => {
	switch (event.type) {
		case "message_start": {
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

export interface StreamParserConfig {
	readonly onUpdate: (patch: Partial<AgentRun>) => void;
	readonly now?: () => number;
}

export class StreamParser {
	private readonly accumulator = createAccumulator();
	private stderrBuffer = "";
	private pendingLine = "";
	private hasParsed = false;

	constructor(
		private readonly name: string,
		private readonly task: string,
		private readonly config: StreamParserConfig
	) {}

	public async parse(
		handle: ProcessHandle,
		signal?: AbortSignal
	): Promise<Partial<AgentRun>> {
		if (this.hasParsed) {
			throw new Error("StreamParser instance has already executed parse()");
		}
		this.hasParsed = true;
		this.accumulator.state = "thinking";
		this.config.onUpdate({
			state: this.accumulator.state,
			transcript: this.accumulator.transcript,
			activity: this.accumulator.activity,
		});

		const now = this.config.now ?? (() => Date.now());
		let aborted = false;
		let cleanUp: (() => void) | null = null;

		const consumeLine = (line: string): void => {
			if (line.length === 0) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return;
			}
			if (!parsed || typeof parsed !== "object") return;
			const event = parsed as StreamEvent;
			if (typeof event.type !== "string") return;
			if (!applyStreamEvent(this.accumulator, event)) return;
			this.config.onUpdate({
				state: this.accumulator.state,
				transcript: this.accumulator.transcript,
				activity: this.accumulator.activity,
			});
		};

		const stdoutListener = (chunk: Buffer) => {
			this.pendingLine += chunk.toString("utf-8");
			let newlineIndex = this.pendingLine.indexOf("\n");
			while (newlineIndex !== -1) {
				consumeLine(this.pendingLine.slice(0, newlineIndex));
				this.pendingLine = this.pendingLine.slice(newlineIndex + 1);
				newlineIndex = this.pendingLine.indexOf("\n");
			}
		};

		const stderrListener = (chunk: Buffer) => {
			this.stderrBuffer += chunk.toString("utf-8");
		};

		const onAbort = (): void => {
			aborted = true;
			handle.kill();
		};

		return new Promise<Partial<AgentRun>>((resolve) => {
			const finalize = (exitCode: number | null): void => {
				if (cleanUp) {
					cleanUp();
					cleanUp = null;
				}
				if (this.pendingLine.length > 0) consumeLine(this.pendingLine);

				const failed =
					aborted ||
					exitCode !== 0 ||
					this.accumulator.stopReason === "error" ||
					this.accumulator.stopReason === "aborted" ||
					this.accumulator.errorMessage !== undefined;

				let lastError: string | null = null;
				let finalState: AgentState = "done";

				if (failed) {
					finalState = "error";
					const trimmedStderr = this.stderrBuffer.trim();
					lastError =
						this.accumulator.errorMessage ??
						(trimmedStderr.length > 0 ? trimmedStderr : null) ??
						(aborted ? "aborted" : null) ??
						`pi exited with code ${exitCode ?? "unknown"}`;
				}

				resolve({
					state: finalState,
					endedAt: now(),
					activity: null,
					lastError,
				});
			};

			const errorListener = (error: Error) => {
				this.accumulator.errorMessage = error.message;
				finalize(null);
			};

			handle.stdout.on("data", stdoutListener);
			handle.stderr.on("data", stderrListener);
			handle.on("error", errorListener);
			handle.on("close", finalize);

			if (signal) {
				if (signal.aborted) {
					onAbort();
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			cleanUp = () => {
				handle.stdout.off("data", stdoutListener);
				handle.stderr.off("data", stderrListener);
				handle.off?.("error", errorListener);
				handle.off?.("close", finalize);
				signal?.removeEventListener("abort", onAbort);
			};
		});
	}
}
