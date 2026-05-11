import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.js";
import {
	type Totals,
	type ColorFn,
	formatModelSegment,
	formatDirectorySegment,
	formatGitSegment,
	formatTokenSegment,
	formatContextSegment,
} from "./segments.js";

type Theme = ExtensionContext["ui"]["theme"];

// ── FooterInput ────────────────────────────────────────────────

export type FooterInput = {
	modelId: string;
	thinkingLevel?: string;
	directory?: string;
	gitBranch?: string;
	gitDirtyCount: number;
	contextUsed: number;
	contextMax?: number;
	totals: Totals;
	config: ResolvedConfig;
};

// ── Renderer ───────────────────────────────────────────────────

export function renderFooter(
	input: FooterInput,
	theme: Theme,
	width: number,
): string[] {
	const cf: ColorFn = (colorName, text) => theme.fg(colorName as never, text);
	const cfg = input.config;
	const separator = cf(cfg.colors.separator, " | ");

	const modelSegment = formatModelSegment(
		input.modelId,
		input.thinkingLevel,
		cfg.modelAliases,
		cfg.showEffort,
		cf,
		cfg.colors.model,
	);

	const dirSegment = cfg.showDirectory
		? formatDirectorySegment(input.directory, cf, cfg.colors.directory)
		: undefined;

	const gitSegment = cfg.showGit
		? formatGitSegment(
				input.gitBranch,
				input.gitDirtyCount,
				cf,
				cfg.colors.git,
				cfg.colors.gitDirty,
			)
		: undefined;

	const ctxSegment = cfg.showContext
		? formatContextSegment(
				input.contextUsed,
				input.contextMax,
				cfg.contextWarningPercent,
				cfg.contextDangerPercent,
				cf,
				{
					normal: cfg.colors.contextNormal,
					warning: cfg.colors.contextWarning,
					danger: cfg.colors.contextDanger,
					dim: "dim",
				},
			)
		: undefined;

	const leftFull = [modelSegment, dirSegment, gitSegment]
		.filter(Boolean)
		.join(separator);
	const leftMin = modelSegment;

	if (width >= 100) {
		const right = joinRightSegments(
			separator,
			ctxSegment,
			formatTokenSegment(
				input.totals,
				"full",
				cfg.showTokens,
				cfg.showCache,
				cf,
				cfg.colors.tokens,
			),
		);
		return [joinLeftRight(leftFull, right, width)];
	}

	if (width >= 80) {
		const right = joinRightSegments(
			separator,
			ctxSegment,
			formatTokenSegment(
				input.totals,
				"no-cache",
				cfg.showTokens,
				cfg.showCache,
				cf,
				cfg.colors.tokens,
			),
		);
		return [joinLeftRight(leftFull, right, width)];
	}

	if (width >= 60) {
		const right = joinRightSegments(
			separator,
			ctxSegment,
			formatTokenSegment(
				input.totals,
				"total-only",
				cfg.showTokens,
				cfg.showCache,
				cf,
				cfg.colors.tokens,
			),
		);
		return [joinLeftRight(leftFull, right, width)];
	}

	if (width >= 40) return [joinLeftRight(leftFull, ctxSegment ?? "", width)];
	return [joinLeftRight(leftMin, ctxSegment ?? "", width)];
}

// ── Layout helpers ─────────────────────────────────────────────

function joinRightSegments(
	separator: string,
	...segments: Array<string | undefined>
): string {
	return segments.filter(Boolean).join(separator);
}

function joinLeftRight(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	if (!left) return truncateToWidth(right, width);

	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1) return truncateToWidth(left + " ".repeat(gap) + right, width);

	const half = Math.max(1, Math.floor((width - 1) / 2));
	return (
		truncateToWidth(left, half) + " " + truncateToWidth(right, width - half - 1)
	);
}
