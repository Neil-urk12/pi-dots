import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Parse parent model from ~/.pi/agent/settings.json.
 * Returns "provider/model" string or undefined if not available.
 */
export function parseParentModel(settingsDir?: string): string | undefined {
	try {
		const dir = settingsDir || path.join(os.homedir(), ".pi", "agent");
		const settingsPath = path.join(dir, "settings.json");
		if (!fs.existsSync(settingsPath)) return undefined;

		const raw = fs.readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw);
		const provider = settings.defaultProvider?.trim();
		const model = settings.defaultModel?.trim();
		if (provider && model) {
			return `${provider}/${model}`;
		}
		return undefined;
	} catch (e) {
		console.warn(
			"[subagents] Failed to parse settings.json:",
			e instanceof Error ? e.message : e,
		);
		return undefined;
	}
}
