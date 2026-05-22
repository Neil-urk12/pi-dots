import { existsSync, readFileSync } from "node:fs";
import type { CleanFooterConfig, ConfigLoadResult } from "./configSchema.js";
import { resolveConfigWithWarnings, mergeConfig } from "./configSchema.js";

// Re-export everything from configSchema for backward compatibility
export * from "./configSchema.js";

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
