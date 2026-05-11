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
