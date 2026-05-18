/**
 * Subagent Extension — Type Definitions
 *
 * Core types for background subagent execution, signal protocol,
 * and UI state tracking.
 */

// ═══ Subagent Phases ═══

export type SubagentPhase = "launching" | "running" | "done" | "failed";

// ═══ Signal Protocol ═══

export type SubagentSignalPhase = "RUNNING" | "TASK_DONE" | "COMPLETE" | "FAILED";

export interface SubagentSignal {
	phase: SubagentSignalPhase;
	subagentId: string;
	agent: string;
	message: string;
	progress?: number; // 0-1
	cost?: number;
}

// ═══ Stream State ═══

export interface SubagentStreamState {
	subagentId: string;
	agent: string;
	lastLine: string;
	tokens: number;
}

// ═══ Log Entries ═══

export interface SubagentLogEntry {
	timestamp: number;
	level: "info" | "warning" | "error";
	text: string;
}

// ═══ Metrics ═══

export interface SubagentMetrics {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	model?: string;
}

// ═══ Running Subagent State ═══

export interface RunningSubagent {
	id: string;
	agent: string;
	task: string;
	phase: SubagentPhase;
	abortController: AbortController;
	stream: SubagentStreamState;
	logs: SubagentLogEntry[];
	metrics: SubagentMetrics;
	startedAt: number;
	finishedAt: number | null;
	promise?: Promise<unknown>;
}
