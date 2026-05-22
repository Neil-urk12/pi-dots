export function normalizeThinkingLevel(level: unknown): string | undefined {
	if (typeof level !== "string") return undefined;

	const normalized = level.toLowerCase();
	if (normalized === "medium") return "med";
	if (
		normalized === "extra-high" ||
		normalized === "extra_high" ||
		normalized === "x-high"
	)
		return "xhigh";
	if (["low", "med", "high", "xhigh"].includes(normalized))
		return normalized;

	return undefined;
}

export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000)
		return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}