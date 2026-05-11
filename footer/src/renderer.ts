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

// ── Segment Builder ────────────────────────────────────────────

export function buildSegments(
	input: FooterInput,
	cf: ColorFn,
): {
	model: string;
	dir?: string;
	git?: string;
	context?: string;
	tokens: {
		full?: string;
		noCache?: string;
		totalOnly?: string;
	};
} {
	const cfg = input.config;

	const model = formatModelSegment(
		input.modelId,
		input.thinkingLevel,
		cfg.modelAliases,
		cfg.showEffort,
		cf,
		cfg.colors.model,
	);

	const dir = cfg.showDirectory
		? formatDirectorySegment(input.directory, cf, cfg.colors.directory)
		: undefined;

	const git = cfg.showGit
		? formatGitSegment(
				input.gitBranch,
				input.gitDirtyCount,
				cf,
				cfg.colors.git,
				cfg.colors.gitDirty,
			)
		: undefined;

	const context = cfg.showContext
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

	const tokens: {
		full?: string;
		noCache?: string;
		totalOnly?: string;
	} = {};
	if (cfg.showTokens) {
		tokens.full = formatTokenSegment(
			input.totals,
			"full",
			true,
			cfg.showCache,
			cf,
			cfg.colors.tokens,
		);
		tokens.noCache = formatTokenSegment(
			input.totals,
			"no-cache",
			true,
			cfg.showCache,
			cf,
			cfg.colors.tokens,
		);
		tokens.totalOnly = formatTokenSegment(
			input.totals,
			"total-only",
			true,
			cfg.showCache,
			cf,
			cfg.colors.tokens,
		);
	}

	return { model, dir, git, context, tokens };
}

// ── Layout Engine ──────────────────────────────────────────────

export function layout(
	segments: {
		model: string;
		dir?: string;
		git?: string;
		context?: string;
		tokens: {
			full?: string;
			noCache?: string;
			totalOnly?: string;
		};
	},
	separator: string,
	width: number,
): string[] {
	const leftFull = [segments.model, segments.dir, segments.git]
		.filter(Boolean)
		.join(separator);
	const leftMin = segments.model;

	if (width >= 100) {
		const right = [segments.context, segments.tokens.full]
			.filter(Boolean)
			.join(separator);
		return [joinLeftRight(leftFull, right, width)];
	}

	if (width >= 80) {
		const right = [segments.context, segments.tokens.noCache]
			.filter(Boolean)
			.join(separator);
		return [joinLeftRight(leftFull, right, width)];
	}

	if (width >= 60) {
		const right = [segments.context, segments.tokens.totalOnly]
			.filter(Boolean)
			.join(separator);
		return [joinLeftRight(leftFull, right, width)];
	}

	if (width >= 40)
		return [joinLeftRight(leftFull, segments.context ?? "", width)];

	return [joinLeftRight(leftMin, segments.context ?? "", width)];
}

// ── Thin wrapper (backward-compatible) ─────────────────────────

export function renderFooter(
	input: FooterInput,
	theme: Theme,
	width: number,
): string[] {
	const cf: ColorFn = (colorName, text) =>
		theme.fg(colorName as never, text);
	const segments = buildSegments(input, cf);
	const separator = cf(input.config.colors.separator, " | ");
	return layout(segments, separator, width);
}

// ── Layout helpers ─────────────────────────────────────────────

function joinLeftRight(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	if (!left) return truncateToWidth(right, width);

	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1) return truncateToWidth(left + " ".repeat(gap) + right, width);

	const half = Math.max(1, Math.floor((width - 1) / 2));
	return (
		truncateToWidth(left, half) +
		" " +
		truncateToWidth(right, width - half - 1)
	);
}
