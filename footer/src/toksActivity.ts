import type { ToksDisplayState } from "./types.js";

// ── Activity animation constants ─────────────────────────────
const ACTIVITY_CADENCE_MS = 300;
const FINAL_RATE_HIDE_MS = 5000;
const ACTIVITY_DOT_FRAMES = [".  ", ".. ", "..."];

// ── CJK-aware token estimation ───────────────────────────────
const TOK_ASCII = 0.25;
const TOK_CJK_IDEO = 0.67;
const TOK_CJK_PUNCT = 0.5;
const TOK_NON_BMP = 1;
const TOK_OTHER = 0.5;

/**
 * CJK-aware token estimation using character-class weights.
 * Values derived from tiktoken cl100k_base empirical ratios.
 * @see https://github.com/openai/tiktoken
 */
function estimateTokens(text: string): number {
	let total = 0;
	for (const char of text) {
		const cp = char.codePointAt(0) ?? 0;
		if (cp >= 0x20 && cp <= 0x7E) {
			total += TOK_ASCII;
		} else if (
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0x3040 && cp <= 0x309f) ||
			(cp >= 0x30a0 && cp <= 0x30ff) ||
			(cp >= 0xac00 && cp <= 0xd7af) ||
			(cp >= 0x2e80 && cp <= 0x2fdf) ||
			(cp >= 0x3100 && cp <= 0x312f) ||
			(cp >= 0x31f0 && cp <= 0x31ff) ||
			(cp >= 0xff01 && cp <= 0xff5e) ||
			(cp >= 0xff65 && cp <= 0xff9f)
		) {
			total += TOK_CJK_IDEO;
		} else if (cp >= 0x3000 && cp <= 0x303f) {
			total += TOK_CJK_PUNCT;
		} else if (cp > 0xffff) {
			total += TOK_NON_BMP;
		} else {
			total += TOK_OTHER;
		}
	}
	return Math.ceil(total);
}

// ── Tool name normalization ──────────────────────────────────
const TOOL_LABEL_MAP: Record<string, string> = {
	edit: "edit",
	write: "write",
	bash: "bash",
	ctx_shell: "bash",
	read: "read",
	ctx_read: "read",
	Agent: "agent",
	agent_browser: "browser",
};

const PREFIX_MAP: [string, string][] = [
	["gitnexus_", "nexus"],
	["context7_", "docs"],
];

const MAX_UNKNOWN_LENGTH = 8;

function normalizeToolLabel(toolName: string): string {
	if (!toolName) return "";
	const direct = TOOL_LABEL_MAP[toolName];
	if (direct) return direct;
	for (const [prefix, label] of PREFIX_MAP) {
		if (toolName.startsWith(prefix)) return label;
	}
	return toolName.length > MAX_UNKNOWN_LENGTH
		? toolName.slice(0, MAX_UNKNOWN_LENGTH)
		: toolName;
}

// ── Types ────────────────────────────────────────────────────

type ToksSample = {
	startTime: number;
	estimatedTokens: number;
	hasObservedOutput: boolean;
	displayState: ToksDisplayState;
};

export type ToksActivityHandle = {
	/** Assistant message started — enter pending state. */
	onMessageStart(): void;
	/** Streaming delta — accumulate estimate, compute live rate. */
	onMessageUpdate(eventType: string, delta?: string, outputTokens?: number): void;
	/** Assistant message ended — finalize rate or hide. */
	onMessageEnd(outputTokens?: number): void;
	/** Assistant message aborted — keep approximate rate or hide. */
	onMessageAbort(): void;
	/** Tool execution started — enter activity state. */
	onToolStart(toolName: string): void;
	/** Tool execution ended — decrement count, stop timer if zero. */
	onToolEnd(): void;
	/** Read current display state. */
	getState(): ToksDisplayState;
	/** Clear all timers and reset state. */
	shutdown(): void;
};

// ── Factory ──────────────────────────────────────────────────

export function createToksActivity(options: {
	onRenderNeeded: () => void;
}): ToksActivityHandle {
	let sample: ToksSample | undefined;
	let activeToolCount = 0;
	let latestToolLabel = "";
	let activityDotIndex = 0;
	let activityTimer: ReturnType<typeof setInterval> | undefined;
	let endsAtTimer: ReturnType<typeof setTimeout> | undefined;

	// ── Timer helpers ──────────────────────────────────────────

	function startActivityTimer(): void {
		stopActivityTimer();
		activityTimer = setInterval(() => {
			activityDotIndex = (activityDotIndex + 1) % ACTIVITY_DOT_FRAMES.length;
			options.onRenderNeeded();
		}, ACTIVITY_CADENCE_MS);
	}

	function stopActivityTimer(): void {
		if (activityTimer) {
			clearInterval(activityTimer);
			activityTimer = undefined;
		}
	}

	function scheduleEndsAt(): void {
		stopEndsAtTimer();
		endsAtTimer = setTimeout(() => {
			endsAtTimer = undefined;
			if (sample) {
				sample = undefined;
				options.onRenderNeeded();
			}
		}, FINAL_RATE_HIDE_MS);
	}

	function stopEndsAtTimer(): void {
		if (endsAtTimer) {
			clearTimeout(endsAtTimer);
			endsAtTimer = undefined;
		}
	}

	function computeRate(estimatedTokens: number, outputTokens: number | undefined, elapsed: number): ToksDisplayState {
		const currentTokens = (outputTokens && outputTokens > 0) ? outputTokens : estimatedTokens;
		return {
			state: "rate",
			value: currentTokens / elapsed,
			approximate: !(outputTokens && outputTokens > 0),
		};
	}

	// ── Public interface ───────────────────────────────────────

	return {
		onMessageStart(): void {
			stopEndsAtTimer();
			sample = {
				startTime: Date.now(),
				estimatedTokens: 0,
				hasObservedOutput: false,
				displayState: { state: "pending" },
			};
			options.onRenderNeeded();
		},

		onMessageUpdate(eventType: string, delta?: string, outputTokens?: number): void {
			if (!sample || !delta) return;
			if (eventType !== "text_delta" && eventType !== "thinking_delta" && eventType !== "toolcall_delta") return;

			sample.estimatedTokens += estimateTokens(delta);
			sample.hasObservedOutput = true;

			const elapsed = (Date.now() - sample.startTime) / 1000;
			if (elapsed > 0) {
				sample.displayState = computeRate(sample.estimatedTokens, outputTokens, elapsed);
			}

			options.onRenderNeeded();
		},

		onMessageEnd(outputTokens?: number): void {
			activeToolCount = 0;
			stopActivityTimer();
			if (sample) {
				const elapsed = (Date.now() - sample.startTime) / 1000;
				if (outputTokens && outputTokens > 0 && elapsed > 0) {
					sample.displayState = {
						state: "rate",
						value: outputTokens / elapsed,
						approximate: false,
					};
					scheduleEndsAt();
				} else if (sample.hasObservedOutput && elapsed > 0) {
					sample.displayState = {
						state: "rate",
						value: sample.estimatedTokens / elapsed,
						approximate: true,
					};
					scheduleEndsAt();
				} else {
					sample = undefined;
				}
			}
			options.onRenderNeeded();
		},

		onMessageAbort(): void {
			if (sample) {
				if (sample.hasObservedOutput) {
					const elapsed = (Date.now() - sample.startTime) / 1000;
					if (elapsed > 0) {
						sample.displayState = {
							state: "rate",
							value: sample.estimatedTokens / elapsed,
							approximate: true,
						};
					}
				} else {
					sample = undefined;
				}
			}
			options.onRenderNeeded();
		},

		onToolStart(toolName: string): void {
			activeToolCount++;
			latestToolLabel = normalizeToolLabel(toolName) + "...";
			activityDotIndex = 0;
			startActivityTimer();
			options.onRenderNeeded();
		},

		onToolEnd(): void {
			activeToolCount = Math.max(0, activeToolCount - 1);
			if (activeToolCount === 0) {
				stopActivityTimer();
			}
			options.onRenderNeeded();
		},

		getState(): ToksDisplayState {
			if (activeToolCount > 0) {
				return { state: "activity", label: latestToolLabel };
			}
			return sample?.displayState ?? { state: "hidden" };
		},

		shutdown(): void {
			sample = undefined;
			activeToolCount = 0;
			latestToolLabel = "";
			activityDotIndex = 0;
			stopActivityTimer();
			stopEndsAtTimer();
		},
	};
}
