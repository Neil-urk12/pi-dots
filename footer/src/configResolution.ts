// ── Config validation and resolution ───────────────────────────

import {
	footerSegmentIds,
	type CleanFooterConfig,
	type ConfigLoadResult,
	type FooterLayoutConfig,
	type FooterPresetId,
	type FooterSegmentId,
	type ResolvedConfig,
} from "./configTypes.js";
import { footerPresetIds } from "./configTypes.js";
import { defaultFooterLayouts, footerPresetConfigs, defaultConfig } from "./configPresets.js";

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
	const warnings: string[] = [];

	if ("showCache" in config) {
		warnings.push(
			"showCache is deprecated; use showCacheRead and showCacheWrites instead",
		);
	}
	if ("showCache" in config && !("showCacheRead" in config)) {
		config = { ...config, showCacheRead: config.showCache };
	}

	const preset = resolvePresetId(config.preset, warnings);
	const presetConfig = footerPresetConfigs[preset];
	const effectiveConfig = mergeConfig(presetConfig, config);
	const resolvedLayouts = resolveLayouts(effectiveConfig.layouts);

	return {
		config: {
			...defaultConfig,
			...effectiveConfig,
			preset,
			separator:
				typeof effectiveConfig.separator === "string"
					? effectiveConfig.separator
					: defaultConfig.separator,
			layouts: resolvedLayouts.layouts,
			gitRefreshDebounceMs: positiveNumber(
				effectiveConfig.gitRefreshDebounceMs,
				defaultConfig.gitRefreshDebounceMs,
			),
			contextWarningPercent: percentNumber(
				effectiveConfig.contextWarningPercent,
				defaultConfig.contextWarningPercent,
			),
			contextDangerPercent: percentNumber(
				effectiveConfig.contextDangerPercent,
				defaultConfig.contextDangerPercent,
			),
			modelAliases: {
				...defaultConfig.modelAliases,
				...(presetConfig.modelAliases ?? {}),
				...(config.modelAliases ?? {}),
			},
			colors: {
				...defaultConfig.colors,
				...(presetConfig.colors ?? {}),
				...(config.colors ?? {}),
			},
		},
		loadedPaths: [],
		warnings: [...warnings, ...resolvedLayouts.warnings],
	};
}

function resolvePresetId(
	preset: CleanFooterConfig["preset"],
	warnings: string[],
): FooterPresetId {
	if (preset === undefined || preset === "default") return "default";
	if (typeof preset !== "string") {
		warnings.push("preset must be a string; using default preset");
		return "default";
	}
	if ((footerPresetIds as readonly string[]).includes(preset)) {
		return preset as FooterPresetId;
	}
	warnings.push(`unknown preset '${preset}'; using default preset`);
	return "default";
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
		if (left.length === 0 && right.length === 0) {
			warnings.push(`layouts[${index}] has no visible segments; skipping`);
			return [];
		}
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
	val: unknown,
	path: string,
	warnings: string[],
	seen = new Set<FooterSegmentId>(),
): FooterSegmentId[] {
	if (!Array.isArray(val)) {
		warnings.push(`${path} must be an array; using empty segment list`);
		return [];
	}
	const result: FooterSegmentId[] = [];
	for (const segment of val) {
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

function isFooterSegmentId(val: unknown): val is FooterSegmentId {
	return typeof val === "string" && (footerSegmentIds as readonly string[]).includes(val);
}

function isRecord(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null;
}

function positiveLayoutWidth(val: unknown): number | undefined {
	return typeof val === "number" && Number.isFinite(val) && val >= 0 ? val : undefined;
}

function positiveNumber(val: unknown, fallback: number): number {
	return typeof val === "number" && Number.isFinite(val) && val > 0 ? val : fallback;
}

function percentNumber(val: unknown, fallback: number): number {
	return typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 100
		? val
		: fallback;
}
