import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ColorFn, FooterInput, Theme, Totals } from "./types.js";

// ── Public interface ──────────────────────────────────────────

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

// ── Private: segment builder ──────────────────────────────────

function buildSegments(
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

	const model = formatModelSegment(input, cf);

	const dir = cfg.showDirectory
		? directorySegment(input, cf)
		: undefined;

	const git = cfg.showGit
		? gitSegment(input, cf)
		: undefined;

	const context = cfg.showContext
		? contextSegment(input, cf)
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
			cfg.showCache,
			cf,
			cfg.colors.tokens,
		);
		tokens.noCache = formatTokenSegment(
			input.totals,
			"no-cache",
			cfg.showCache,
			cf,
			cfg.colors.tokens,
		);
		tokens.totalOnly = formatTokenSegment(
			input.totals,
			"total-only",
			cfg.showCache,
			cf,
			cfg.colors.tokens,
		);
	}

	return { model, dir, git, context, tokens };
}

// ── Private: low-level helpers ────────────────────────────────

function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000)
		return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatModelName(
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

// ── Private: segment formatters ───────────────────────────────

function formatModelSegment(
	input: FooterInput,
	cf: ColorFn,
): string {
	const model = formatModelName(
		input.modelId,
		input.config.modelAliases,
	);
	const effort =
		input.config.showEffort && input.thinkingLevel
			? ` • ${input.thinkingLevel}`
			: "";
	return cf(input.config.colors.model, `${model}${effort}`);
}

function directorySegment(
	input: FooterInput,
	cf: ColorFn,
): string | undefined {
	if (!input.directory) return undefined;
	return cf(input.config.colors.directory, input.directory);
}

function gitSegment(
	input: FooterInput,
	cf: ColorFn,
): string | undefined {
	if (!input.gitBranch) return undefined;
	const branch = cf(input.config.colors.git, input.gitBranch);
	if (input.gitDirtyCount <= 0) return branch;
	return `${branch} ${cf(
		input.config.colors.gitDirty,
		`●${input.gitDirtyCount}`,
	)}`;
}

function formatTokenSegment(
	totals: Totals,
	mode: "full" | "no-cache" | "total-only",
	showCache: boolean,
	cf: ColorFn,
	tokenColor: string,
): string {
	const effectiveMode =
		showCache ? mode : mode === "full" ? "no-cache" : mode;

	const total = totals.input + totals.output;

	let text: string;
	if (effectiveMode === "total-only") {
		text = `Σ${formatCount(total)}`;
	} else {
		const base = `↑${formatCount(totals.input)} ↓${formatCount(
			totals.output,
		)} Σ${formatCount(total)}`;
		text =
			effectiveMode === "full"
				? `${base} ↯${formatCount(totals.cacheRead)} ↥${formatCount(totals.cacheWrite)}`
				: base;
	}

	return cf(tokenColor, text);
}

function contextSegment(
	input: FooterInput,
	cf: ColorFn,
): string {
	const text = `ctx ${formatCount(input.contextUsed)}/${input.contextMax ? formatCount(input.contextMax) : "--"}`;

	if (!input.contextMax || input.contextMax <= 0)
		return cf("dim", text);

	const percent =
		(input.contextUsed / input.contextMax) * 100;
	if (percent >= input.config.contextDangerPercent)
		return cf(input.config.colors.contextDanger, text);
	if (percent >= input.config.contextWarningPercent)
		return cf(input.config.colors.contextWarning, text);
	return cf(input.config.colors.contextNormal, text);
}

// ── Private: layout engine ────────────────────────────────────

function layout(
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
		const right = [
			segments.context,
			segments.tokens.totalOnly,
		]
			.filter(Boolean)
			.join(separator);
		return [joinLeftRight(leftFull, right, width)];
	}

	if (width >= 40)
		return [
			joinLeftRight(
				leftFull,
				segments.context ?? "",
				width,
			),
		];

	return [
		joinLeftRight(leftMin, segments.context ?? "", width),
	];
}

function joinLeftRight(
	left: string,
	right: string,
	width: number,
): string {
	if (!right) return truncateToWidth(left, width);
	if (!left) return truncateToWidth(right, width);

	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1)
		return truncateToWidth(left + " ".repeat(gap) + right, width);

	const half = Math.max(1, Math.floor((width - 1) / 2));
	return (
		truncateToWidth(left, half) +
		" " +
		truncateToWidth(right, width - half - 1)
	);
}
