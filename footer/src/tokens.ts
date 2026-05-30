import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Totals } from "./types.js";

// ── Accumulator ─────────────────────────────────────────────────

export function accumulateTotals(
	branch: readonly {
		type: string;
		message?: { role: string };
	}[],
): Totals {
	const totals: Totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};

	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const msg = entry.message as AssistantMessage;
		totals.input += msg.usage?.input ?? 0;
		totals.output += msg.usage?.output ?? 0;
		totals.cacheRead += msg.usage?.cacheRead ?? 0;
		totals.cacheWrite += msg.usage?.cacheWrite ?? 0;
	}

	return totals;
}

/**
 * Accumulate total session cost from assistant messages.
 * Returns 0 when no cost data is available (e.g. local/zero-cost models).
 */
export function accumulateCost(
	branch: readonly {
		type: string;
		message?: { role: string };
	}[],
): number {
	let cost = 0;

	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const msg = entry.message as AssistantMessage;
		const total = msg.usage?.cost?.total;
		if (typeof total === "number" && Number.isFinite(total) && total > 0) {
			cost += total;
		}
	}

	return cost;
}
