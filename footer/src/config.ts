import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_GIT_REFRESH_DEBOUNCE_MS = 500;

export type CleanFooterConfig = {
	enabled?: boolean;
	showGit?: boolean;
	showTokens?: boolean;
	showCache?: boolean;
	showContext?: boolean;
	showDirectory?: boolean;
	showEffort?: boolean;
	gitRefreshDebounceMs?: number;
	contextWarningPercent?: number;
	contextDangerPercent?: number;
	modelAliases?: Record<string, string>;
	colors?: Partial<ColorConfig>;
};

export type ResolvedConfig = Required<
	Omit<CleanFooterConfig, "modelAliases" | "colors">
> & {
	modelAliases: Record<string, string>;
	colors: ColorConfig;
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
	error?: string;
};

export const defaultConfig: ResolvedConfig = {
	enabled: true,
	showGit: true,
	showTokens: true,
	showCache: true,
	showContext: true,
	showDirectory: true,
	showEffort: true,
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
): { config: ResolvedConfig; loadedPaths: string[]; error?: string } {
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

	return {
		config: resolveConfig(merged),
		loadedPaths: loaded,
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
	return {
		...defaultConfig,
		...config,
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
	};
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
