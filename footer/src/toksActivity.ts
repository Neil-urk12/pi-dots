import type { ToksDisplayState } from "./types.js";
import { estimateTokens } from "./tokenEstimate.js";
import { normalizeToolLabel } from "./tokLabels.js";

// ── Activity animation constants ─────────────────────────────
const ACTIVITY_CADENCE_MS = 300;
const FINAL_RATE_HIDE_MS = 5000;
const ACTIVITY_DOT_FRAMES = [".  ", ".. ", "..."];

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
