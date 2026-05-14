/**
 * Model name formatting — smart-shorten model IDs for display.
 *
 * Priority:
 *  1. Explicit alias match on the full modelId
 *  2. Explicit alias match on the provider-stripped name
 *  3. Pattern-based shortening for known model families
 *  4. Truncation to 24 characters (with ellipsis at 21)
 */

// ── Public interface ──────────────────────────────────────────

export function formatModelName(
	modelId: string,
	aliases: Record<string, string>,
): string {
	if (aliases[modelId]) return aliases[modelId];

	const lower = modelId.toLowerCase();
	const withoutProvider = lower.includes("/")
		? lower.split("/").pop()!
		: lower;
	if (aliases[withoutProvider]) return aliases[withoutProvider];

	if (
		withoutProvider.includes("claude") &&
		withoutProvider.includes("sonnet")
	) {
		if (
			withoutProvider.includes("4-5") ||
			withoutProvider.includes("4.5")
		)
			return "sonnet-4.5";
		if (withoutProvider.includes("4")) return "sonnet-4";
		return "sonnet";
	}

	if (
		withoutProvider.includes("claude") &&
		withoutProvider.includes("opus")
	)
		return "opus";
	if (
		withoutProvider.includes("claude") &&
		withoutProvider.includes("haiku")
	)
		return "haiku";

	const gpt5 = withoutProvider.match(/gpt-5(?:[.-][a-z0-9]+)*/);
	if (gpt5) return gpt5[0];

	const gpt4 = withoutProvider.match(/gpt-4(?:[.-][a-z0-9]+)*/);
	if (gpt4) return gpt4[0];

	const gemini = withoutProvider.match(/gemini-[a-z0-9.-]+/);
	if (gemini) return gemini[0].replace(/-preview.*/, "");

	return withoutProvider.length > 24
		? `${withoutProvider.slice(0, 21)}…`
		: withoutProvider;
}
