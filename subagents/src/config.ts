import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionConfig } from "./types";

export const DEFAULT_MAX_CONCURRENCY = 4;

export function loadConfig(extDir: string): ExtensionConfig {
	const configPath = path.join(extDir, "config.json");

	try {
		if (fs.existsSync(configPath)) {
			const raw = fs.readFileSync(configPath, "utf-8");
			return JSON.parse(raw) as ExtensionConfig;
		}
	} catch {}

	const userConfigPath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"subagents.json",
	);
	try {
		if (fs.existsSync(userConfigPath)) {
			const raw = fs.readFileSync(userConfigPath, "utf-8");
			return JSON.parse(raw) as ExtensionConfig;
		}
	} catch {}

	return {};
}

export function saveConfig(extDir: string, config: ExtensionConfig): void {
	const configPath = path.join(extDir, "config.json");
	try {
		fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
	} catch {}
}
