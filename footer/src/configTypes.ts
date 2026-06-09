// ── Config types ───────────────────────────────────────────────

export const DEFAULT_GIT_REFRESH_DEBOUNCE_MS = 500;

export const footerSegmentIds = [
	"model",
	"directory",
	"git",
	"context",
	"tokensFull",
	"tokensNoCache",
	"tokensTotal",
	"toks",
	"cost",
] as const;

export type FooterSegmentId = (typeof footerSegmentIds)[number];

export const footerPresetIds = [
	"default",
	"minimal",
	"compact",
	"dense",
	"focus",
	"muted",
] as const;

export type FooterPresetId = (typeof footerPresetIds)[number];

export type FooterLayoutConfig = {
	minWidth: number;
	left: FooterSegmentId[];
	right: FooterSegmentId[];
};

export type CleanFooterConfig = {
	preset?: FooterPresetId | string;
	enabled?: boolean;
	showGit?: boolean;
	showTokens?: boolean;
	/** @deprecated Use showCacheRead and showCacheWrites instead */
	showCache?: boolean;
	showCacheRead?: boolean;
	showCacheWrites?: boolean;
	showContext?: boolean;
	showDirectory?: boolean;
	showEffort?: boolean;
	showCost?: boolean;
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
	cost: string;
	separator: string;
};

export type ConfigLoadResult = {
	config: ResolvedConfig;
	loadedPaths: string[];
	warnings: string[];
	error?: string;
};
