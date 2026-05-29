/**
 * Type guard for objects that carry a `.usage` record.
 */
export function hasUsage(obj: unknown): obj is { usage: Record<string, unknown> } {
	return (
		obj !== null &&
		typeof obj === "object" &&
		"usage" in obj &&
		obj.usage !== null &&
		typeof obj.usage === "object"
	);
}

/**
 * Extract output-token count from a message-like object.
 *
 * Checks `msg.usage.output` first, then `msg.message.usage.output`.
 * Returns `undefined` when the value is missing, non-numeric, or ≤ 0.
 */
export function extractOutputTokens(msg: unknown): number | undefined {
	if (msg === null || typeof msg !== "object") return undefined;

	const obj = msg as Record<string, unknown>;

	const direct = hasUsage(obj) ? obj.usage.output : undefined;
	if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;

	const nested = obj.message;
	if (nested !== null && typeof nested === "object" && hasUsage(nested)) {
		const value = nested.usage.output;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}

	return undefined;
}
