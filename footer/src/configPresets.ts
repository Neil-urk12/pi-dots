// ── Config presets and defaults ─────────────────────────────────

import {
	DEFAULT_GIT_REFRESH_DEBOUNCE_MS,
	type FooterLayoutConfig,
	type FooterPresetId,
	type CleanFooterConfig,
	type ResolvedConfig,
} from "./configTypes.js";

export const defaultFooterLayouts: FooterLayoutConfig[] = [
	{
		minWidth: 100,
		left: ["model", "directory", "git", "toks"],
		right: ["cost", "context", "tokensFull"],
	},
	{
		minWidth: 80,
		left: ["model", "directory", "git", "toks"],
		right: ["cost", "context", "tokensNoCache"],
	},
	{
		minWidth: 60,
		left: ["model", "directory", "git", "toks"],
		right: ["cost", "context", "tokensTotal"],
	},
	{ minWidth: 40, left: ["model", "directory", "git"], right: ["cost", "context"] },
	{ minWidth: 0, left: ["model"], right: ["context"] },
];

const minimalLayouts: FooterLayoutConfig[] = [{ minWidth: 0, left: ["model"], right: ["context"] }];

const compactLayouts: FooterLayoutConfig[] = [
	{ minWidth: 80, left: ["model", "git"], right: ["context", "tokensTotal"] },
	{ minWidth: 0, left: ["model"], right: ["context"] },
];

const denseLayouts: FooterLayoutConfig[] = [
	{ minWidth: 100, left: ["model", "directory", "git", "toks"], right: ["context", "tokensFull"] },
	{ minWidth: 60, left: ["model", "git"], right: ["context", "tokensNoCache"] },
	{ minWidth: 0, left: ["model"], right: ["context"] },
];

const focusLayouts: FooterLayoutConfig[] = [{ minWidth: 0, left: ["model"], right: ["context"] }];

export const footerPresetConfigs: Record<FooterPresetId, CleanFooterConfig> = {
	default: {},
	minimal: {
		separator: " · ",
		showDirectory: false,
		showGit: false,
		showTokens: false,
		layouts: minimalLayouts,
	},
	compact: {
		separator: " · ",
		showDirectory: false,
		showCacheRead: false,
		showCacheWrites: false,
		layouts: compactLayouts,
	},
	dense: {
		showCacheRead: true,
		showCacheWrites: true,
		layouts: denseLayouts,
	},
	focus: {
		showDirectory: false,
		showGit: false,
		showTokens: false,
		layouts: focusLayouts,
	},
	muted: {
		colors: {
			model: "muted",
			directory: "dim",
			git: "muted",
			gitDirty: "warning",
			contextNormal: "muted",
			contextWarning: "warning",
			contextDanger: "error",
			tokens: "dim",
			cost: "dim",
			separator: "dim",
		},
	},
};

export const defaultConfig: ResolvedConfig = {
	preset: "default",
	enabled: true,
	showGit: true,
	showTokens: true,
	showCacheRead: true,
	showCacheWrites: false,
	showContext: true,
	showDirectory: true,
	showEffort: true,
	showCost: true,
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
		cost: "muted",
		separator: "dim",
	},
};
