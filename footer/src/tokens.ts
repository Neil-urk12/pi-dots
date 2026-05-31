import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Totals } from "./types.js";

// ── Entry filter ─────────────────────────────────────────────

type Entry = readonly {
	type: string;
	message?: { role: string };
}[];

function* assistantMessages(branch: Entry) {
	for (const entry of branch) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			yield entry.message as AssistantMessage;
		}
	}
}

// ── Accumulator ─────────────────────────────────────────────────

export function accumulateTotals(branch: Entry): Totals {
	const totals: Totals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};

	for (const msg of assistantMessages(branch)) {
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
export function accumulateCost(branch: Entry): number {
	let cost = 0;

	for (const msg of assistantMessages(branch)) {
		const total = msg.usage?.cost?.total;
		if (typeof total === "number" && Number.isFinite(total) && total > 0) {
			cost += total;
		}
	}

	return cost;
}
