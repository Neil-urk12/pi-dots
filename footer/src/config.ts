import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_GIT_REFRESH_DEBOUNCE_MS = 500;

export const footerSegmentIds = [
	"model",
	"directory",
	"git",
	"context",
	"tokensFull",
	"tokensNoCache",
	"tokensTotal",
] as const;

export type FooterSegmentId = (typeof footerSegmentIds)[number];

export type FooterLayoutConfig = {
	minWidth: number;
	left: FooterSegmentId[];
	right: FooterSegmentId[];
};

export type CleanFooterConfig = {
	enabled?: boolean;
	showGit?: boolean;
	showTokens?: boolean;
	showCache?: boolean;
	showContext?: boolean;
	showDirectory?: boolean;
	showEffort?: boolean;
	separator?: string;
	layouts?: FooterLayoutConfig[];
	gitRefreshDebounceMs?: number;
	contextWarningPercent?: number;
	contextDangerPercent?: number;
	modelAliases?: Record<string, string>;
	colors?: Partial<ColorConfig>;
};

export type ResolvedConfig = Required<
	Omit<CleanFooterConfig, "modelAliases" | "colors" | "layouts">
> & {
	modelAliases: Record<string, string>;
	colors: ColorConfig;
	layouts: FooterLayoutConfig[];
};

export type ColorConfig = {
	model: string;
	directory: string;
	git: string;
	gitDirty: string;
	contextNormal: string;
	contextWarning: string;
	contextDanger: string;
	tokens: string;
	separator: string;
};

export type ConfigLoadResult = {
	config: ResolvedConfig;
	loadedPaths: string[];
	warnings: string[];
	error?: string;
};

export const defaultFooterLayouts: FooterLayoutConfig[] = [
	{
		minWidth: 100,
		left: ["model", "directory", "git"],
		right: ["context", "tokensFull"],
	},
	{
		minWidth: 80,
		left: ["model", "directory", "git"],
		right: ["context", "tokensNoCache"],
	},
	{
		minWidth: 60,
		left: ["model", "directory", "git"],
		right: ["context", "tokensTotal"],
	},
	{
		minWidth: 40,
		left: ["model", "directory", "git"],
		right: ["context"],
	},
	{
		minWidth: 0,
		left: ["model"],
		right: ["context"],
	},
];

export const defaultConfig: ResolvedConfig = {
	enabled: true,
	showGit: true,
	showTokens: true,
	showCache: true,
	showContext: true,
	showDirectory: true,
	showEffort: true,
	separator: " | ",
	layouts: defaultFooterLayouts,
	gitRefreshDebounceMs: DEFAULT_GIT_REFRESH_DEBOUNCE_MS,
	contextWarningPercent: 70,
	contextDangerPercent: 85,
	modelAliases: {},
	colors: {
		model: "accent",
		directory: "dim",
		git: "success",
		gitDirty: "warning",
		contextNormal: "success",
		contextWarning: "warning",
		contextDanger: "error",
		tokens: "muted",
		separator: "dim",
	},

};

export function loadFooterConfig(
	globalPath: string,
	projectPath: string,
): ConfigLoadResult {
	return loadConfig([globalPath, projectPath]);
}

export function loadConfig(paths: string[]): ConfigLoadResult {
	const loaded: string[] = [];
	let merged: CleanFooterConfig = {};
	let error: string | undefined;

	for (const configPath of paths) {
		if (!existsSync(configPath)) continue;
		try {
			const parsed = JSON.parse(
				readFileSync(configPath, "utf8"),
			) as CleanFooterConfig;
			merged = mergeConfig(merged, parsed);
			loaded.push(configPath);
		} catch (err) {
			error = `${configPath}: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	const resolved = resolveConfigWithWarnings(merged);
	return {
		config: resolved.config,
		loadedPaths: loaded,
		warnings: resolved.warnings,
		error,
	};
}

export function mergeConfig(
	base: CleanFooterConfig,
	override: CleanFooterConfig,
): CleanFooterConfig {
	return {
		...base,
		...override,
		modelAliases: {
			...(base.modelAliases ?? {}),
			...(override.modelAliases ?? {}),
		},
		colors: {
			...(base.colors ?? {}),
			...(override.colors ?? {}),
		},
	};
}

export function resolveConfig(config: CleanFooterConfig): ResolvedConfig {
	return resolveConfigWithWarnings(config).config;
}

export function resolveConfigWithWarnings(config: CleanFooterConfig): ConfigLoadResult {
	const resolvedLayouts = resolveLayouts(config.layouts);
	return {
		config: {
			...defaultConfig,
			...config,
			separator: typeof config.separator === "string"
				? config.separator
				: defaultConfig.separator,
			layouts: resolvedLayouts.layouts,
			gitRefreshDebounceMs: positiveNumber(
				config.gitRefreshDebounceMs,
				defaultConfig.gitRefreshDebounceMs,
			),
			contextWarningPercent: percentNumber(
				config.contextWarningPercent,
				defaultConfig.contextWarningPercent,
			),
			contextDangerPercent: percentNumber(
				config.contextDangerPercent,
				defaultConfig.contextDangerPercent,
			),
			modelAliases: {
				...defaultConfig.modelAliases,
				...(config.modelAliases ?? {}),
			},
			colors: { ...defaultConfig.colors, ...(config.colors ?? {}) },
		},
		loadedPaths: [],
		warnings: resolvedLayouts.warnings,
	};
}

function resolveLayouts(layouts: unknown): {
	layouts: FooterLayoutConfig[];
	warnings: string[];
} {
	const warnings: string[] = [];
	if (layouts === undefined) return { layouts: defaultFooterLayouts, warnings };

	if (!Array.isArray(layouts)) {
		return {
			layouts: defaultFooterLayouts,
			warnings: ["layouts must be an array; using default layouts"],
		};
	}

	const resolved = layouts.flatMap((layout, index) => {
		if (!isRecord(layout)) {
			warnings.push(`layouts[${index}] must be an object; skipping`);
			return [];
		}

		const minWidth = positiveLayoutWidth(layout.minWidth);
		if (minWidth === undefined) {
			warnings.push(`layouts[${index}].minWidth must be a non-negative number; skipping`);
			return [];
		}

		const left = resolveSegmentList(layout.left, `layouts[${index}].left`, warnings);
		const right = resolveSegmentList(
			layout.right,
			`layouts[${index}].right`,
			warnings,
			new Set(left),
		);
		return [{ minWidth, left, right }];
	});

	if (resolved.length === 0) {
		warnings.push("no valid layouts configured; using default layouts");
		return { layouts: defaultFooterLayouts, warnings };
	}

	return {
		layouts: [...resolved].sort((a, b) => b.minWidth - a.minWidth),
		warnings,
	};
}

function resolveSegmentList(
	value: unknown,
	path: string,
	warnings: string[],
	seen = new Set<FooterSegmentId>(),
): FooterSegmentId[] {
	if (!Array.isArray(value)) {
		warnings.push(`${path} must be an array; using empty segment list`);
		return [];
	}

	const result: FooterSegmentId[] = [];
	for (const segment of value) {
		if (!isFooterSegmentId(segment)) {
			warnings.push(`${path} contains unknown segment '${String(segment)}'; omitting`);
			continue;
		}
		if (seen.has(segment)) {
			warnings.push(`${path} contains duplicate segment '${segment}'; omitting`);
			continue;
		}
		seen.add(segment);
		result.push(segment);
	}
	return result;
}

function isFooterSegmentId(value: unknown): value is FooterSegmentId {
	return typeof value === "string" &&
		(footerSegmentIds as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function positiveLayoutWidth(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function percentNumber(value: unknown, fallback: number): number {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
		? value
		: fallback;
}
