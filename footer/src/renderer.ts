import { layout } from "./layout.js";
import type { ColorFn, FooterInput, Theme } from "./types.js";
import type { FooterLayoutConfig, FooterSegmentId } from "./configTypes.js";
import { formatModelName } from "./modelName.js";
import { formatFullTokens, formatNoCacheTokens, formatTotalOnlyTokens } from "./tokenFormat.js";
import { formatCount } from "./utils.js";

// ── Public interface ──────────────────────────────────────────

export function renderFooter(input: FooterInput, theme: Theme, width: number): string[] {
	const cf: ColorFn = (colorName, text) => theme.fg(colorName as never, text);
	const segments = buildSegments(input, cf);
	const separator = cf(input.config.colors.separator, input.config.separator);
	return [renderLayout(segments, separator, input.config.layouts, width)];
}

// ── Private: segment builder ──────────────────────────────────

// Segment values are lazy (closures) for token variants — only the active layout's variant is computed.
type SegmentMap = Record<FooterSegmentId, string | undefined | (() => string | undefined)>;

function buildSegments(input: FooterInput, cf: ColorFn): SegmentMap {
	const cfg = input.config;

	// Token segments are lazy — only the variant referenced by the active layout is computed.
	const tokenSegments = cfg.showTokens
		? {
				tokensFull: () =>
					formatFullTokens(input.totals, {
						showCacheRead: cfg.showCacheRead,
						showCacheWrites: cfg.showCacheWrites,
						cf,
						color: cfg.colors.tokens,
					}),
				tokensNoCache: () => formatNoCacheTokens(input.totals, cf, cfg.colors.tokens),
				tokensTotal: () => formatTotalOnlyTokens(input.totals, cf, cfg.colors.tokens),
			}
		: {};

	return {
		model: formatModelSegment(input, cf),
		directory: cfg.showDirectory ? directorySegment(input, cf) : undefined,
		git: cfg.showGit ? gitSegment(input, cf) : undefined,
		context: cfg.showContext ? contextSegment(input, cf) : undefined,
		...tokenSegments,
		toks: toksSegment(input, cf),
		cost: costSegment(input, cf),
	};
}

// ── Private: low-level helpers ────────────────────────────────

// ── Private: segment formatters ───────────────────────────────

function formatModelSegment(input: FooterInput, cf: ColorFn): string {
	const model = formatModelName(input.modelId, input.config.modelAliases);
	const effort = input.config.showEffort && input.thinkingLevel ? ` • ${input.thinkingLevel}` : "";
	return cf(input.config.colors.model, `${model}${effort}`);
}

function directorySegment(input: FooterInput, cf: ColorFn): string | undefined {
	if (!input.directory) return undefined;
	return cf(input.config.colors.directory, input.directory);
}

function gitSegment(input: FooterInput, cf: ColorFn): string | undefined {
	if (!input.gitBranch) return undefined;
	const branch = cf(input.config.colors.git, input.gitBranch);
	if (input.gitDirtyCount <= 0) return branch;
	return `${branch} ${cf(input.config.colors.gitDirty, `●${input.gitDirtyCount}`)}`;
}

function contextSegment(input: FooterInput, cf: ColorFn): string {
	const text = `ctx ${formatCount(input.contextUsed)}/${input.contextMax ? formatCount(input.contextMax) : "--"}`;

	if (!input.contextMax || input.contextMax <= 0) return cf("dim", text);

	const percent = (input.contextUsed / input.contextMax) * 100;
	if (percent >= input.config.contextDangerPercent)
		return cf(input.config.colors.contextDanger, text);
	if (percent >= input.config.contextWarningPercent)
		return cf(input.config.colors.contextWarning, text);
	return cf(input.config.colors.contextNormal, text);
}

function toksSegment(input: FooterInput, cf: ColorFn): string | undefined {
	const ts = input.toksState;
	if (ts.state === "hidden") return undefined;
	if (ts.state === "activity") return cf(input.config.colors.tokens, ts.label);
	if (ts.state === "pending") return cf(input.config.colors.tokens, "… tok/s");
	const rounded = Math.round(ts.value);
	if (ts.approximate) return cf(input.config.colors.tokens, `≈${rounded} tok/s`);
	return cf(input.config.colors.tokens, `${rounded} tok/s`);
}

function costSegment(input: FooterInput, cf: ColorFn): string | undefined {
	if (!input.config.showCost) return undefined;
	if (input.sessionCost == null || input.sessionCost <= 0) return undefined;
	return cf(input.config.colors.cost, `$${input.sessionCost.toFixed(2)}`);
}

// ── Private: width-tier branching ──────────────────────────────

function renderLayout(
	segments: SegmentMap,
	separator: string,
	layouts: FooterLayoutConfig[],
	width: number,
): string {
	const selectedLayout = selectLayout(layouts, width);
	const left = resolveLayoutSegments(selectedLayout.left, segments);
	const right = resolveLayoutSegments(selectedLayout.right, segments);
	return layout(left, right, separator, width);
}

function selectLayout(layouts: FooterLayoutConfig[], width: number): FooterLayoutConfig {
	return layouts.find((candidate) => width >= candidate.minWidth) ?? layouts[layouts.length - 1];
}

function resolveLayoutSegments(segmentIds: FooterSegmentId[], segments: SegmentMap): string[] {
	return segmentIds
		.map((segmentId) => {
			const val = segments[segmentId];
			return typeof val === "function" ? val() : val;
		})
		.filter((segment): segment is string => Boolean(segment));
}
