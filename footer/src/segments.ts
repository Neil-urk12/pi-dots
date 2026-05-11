import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

// ── Types ──────────────────────────────────────────────────────

export type ColorFn = (colorName: string, text: string) => string;

export type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

// ── Low-level helpers ──────────────────────────────────────────

export function color(theme: Theme, colorName: string, text: string): string {
	return theme.fg(colorName as never, text);
}

export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000)
		return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

// ── Model name ─────────────────────────────────────────────────

export function formatModelName(
	modelId: string,
	aliases: Record<string, string>,
): string {
	if (aliases[modelId]) return aliases[modelId];

	const lower = modelId.toLowerCase();
	const withoutProvider = lower.includes("/") ? lower.split("/").pop()! : lower;
	if (aliases[withoutProvider]) return aliases[withoutProvider];

	if (
		withoutProvider.includes("claude") &&
		withoutProvider.includes("sonnet")
	) {
		if (withoutProvider.includes("4-5") || withoutProvider.includes("4.5"))
			return "sonnet-4.5";
		if (withoutProvider.includes("4")) return "sonnet-4";
		return "sonnet";
	}

	if (withoutProvider.includes("claude") && withoutProvider.includes("opus"))
		return "opus";
	if (withoutProvider.includes("claude") && withoutProvider.includes("haiku"))
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

// ── Segment formatters ─────────────────────────────────────────

export function formatModelSegment(
	modelId: string,
	thinkingLevel: string | undefined,
	aliases: Record<string, string>,
	showEffort: boolean,
	colorFn: ColorFn,
	modelColor: string,
): string {
	const model = formatModelName(modelId, aliases);
	const effort = showEffort && thinkingLevel ? ` • ${thinkingLevel}` : "";
	return colorFn(modelColor, `${model}${effort}`);
}

export function formatDirectorySegment(
	dir: string | undefined,
	colorFn: ColorFn,
	dirColor: string,
): string | undefined {
	if (!dir) return undefined;
	return colorFn(dirColor, dir);
}

export function formatGitSegment(
	branch: string | undefined,
	dirtyCount: number,
	colorFn: ColorFn,
	gitColor: string,
	dirtyColor: string,
): string | undefined {
	if (!branch) return undefined;
	const branchStr = colorFn(gitColor, branch);
	if (dirtyCount <= 0) return branchStr;
	return `${branchStr} ${colorFn(dirtyColor, `●${dirtyCount}`)}`;
}

export function formatTokenSegment(
	totals: Totals,
	mode: "full" | "no-cache" | "total-only",
	showTokens: boolean,
	showCache: boolean,
	colorFn: ColorFn,
	tokenColor: string,
): string | undefined {
	if (!showTokens) return undefined;
	const effectiveMode = showCache ? mode : mode === "full" ? "no-cache" : mode;

	const total = totals.input + totals.output;

	let text: string;
	if (effectiveMode === "total-only") {
		text = `Σ${formatCount(total)}`;
	} else {
		const base = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)} Σ${formatCount(total)}`;
		text =
			effectiveMode === "full"
				? `${base} ↯${formatCount(totals.cacheRead)} ↥${formatCount(totals.cacheWrite)}`
				: base;
	}

	return colorFn(tokenColor, text);
}

export function formatContextSegment(
	used: number,
	contextMax: number | undefined,
	warningPercent: number,
	dangerPercent: number,
	colorFn: ColorFn,
	colors: { normal: string; warning: string; danger: string; dim: string },
): string {
	const text = `ctx ${formatCount(used)}/${contextMax ? formatCount(contextMax) : "--"}`;

	if (!contextMax || contextMax <= 0) return colorFn(colors.dim, text);

	const percent = (used / contextMax) * 100;
	if (percent >= dangerPercent) return colorFn(colors.danger, text);
	if (percent >= warningPercent) return colorFn(colors.warning, text);
	return colorFn(colors.normal, text);
}
