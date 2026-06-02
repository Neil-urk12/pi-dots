/**
 * Config for free-models extension.
 *
 * Keys and flags resolved in order (first wins):
 *   1. Environment variable
 *   2. ~/.pi/free-models.json (separate from pi-free's ~/.pi/free.json)
 *
 * All exported values are getter functions so runtime changes are visible immediately.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./lib/logger.ts";

const _logger = createLogger("config");

interface FreeModelsConfig {
	kilo_api_key?: string;
	opencode_api_key?: string;
	free_only?: boolean;
	kilo_show_paid?: boolean;
	opencode_show_paid?: boolean;
	hidden_models?: string[];
}

const CONFIG_TEMPLATE: FreeModelsConfig = {
	kilo_api_key: "",
	opencode_api_key: "",
	free_only: true,
	kilo_show_paid: false,
	opencode_show_paid: false,
	hidden_models: [],
};

const PI_DIR = join(process.env.HOME || process.env.USERPROFILE || "", ".pi");
const CONFIG_PATH = join(PI_DIR, "free-models.json");

function ensureConfigFile(): void {
	try {
		mkdirSync(PI_DIR, { recursive: true });
		if (existsSync(CONFIG_PATH)) {
			let existing: FreeModelsConfig;
			try {
				existing = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FreeModelsConfig;
			} catch {
				_logger.error(
					"Config file exists but is corrupt — refusing to overwrite. Fix or delete ~/.pi/free-models.json.",
					{ path: CONFIG_PATH },
				);
				return;
			}
			const merged = { ...CONFIG_TEMPLATE, ...existing };
			if (JSON.stringify(merged) !== JSON.stringify(existing)) {
				writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
			}
		} else {
			writeFileSync(CONFIG_PATH, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, "utf8");
		}
	} catch (err) {
		_logger.warn("Could not create config file", {
			path: CONFIG_PATH,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function loadConfigFile(): FreeModelsConfig {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as FreeModelsConfig;
	} catch {
		return {};
	}
}

function readRawConfigFile(): string | undefined {
	try {
		return readFileSync(CONFIG_PATH, "utf8");
	} catch {
		return undefined;
	}
}

ensureConfigFile();

// Resolve each value: env var takes priority over config file.
export function resolve(envKey: string, fileVal?: string): string | undefined {
	return process.env[envKey] || (fileVal?.trim() ? fileVal : undefined);
}

// Resolve boolean flag: env var takes priority, then config file.
function resolveBool(envKey: string, fileVal?: boolean): boolean {
	const envValue = process.env[envKey];
	if (envValue === "true") return true;
	if (envValue === "false") return false;
	return fileVal === true;
}

// =============================================================================
// API Keys
// =============================================================================

/**
 * Read an API key from ~/.pi/agent/auth.json.
 * Pi stores built-in provider keys there.
 * Falls back to env var if auth.json is missing or key not found.
 */
function readAuthJsonKey(providerId: string, envVar: string): string | undefined {
	const envVal = process.env[envVar];
	if (envVal) return envVal;

	try {
		const authPath = join(PI_DIR, "agent", "auth.json");
		if (!existsSync(authPath)) return undefined;
		const raw = readFileSync(authPath, "utf8");
		const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string }>;
		const entry = auth[providerId];
		if (entry?.key?.trim()) return entry.key;
	} catch {
		// auth.json missing or corrupt — silently skip
	}
	return undefined;
}

export function getKiloApiKey(): string | undefined {
	return resolve("KILO_API_KEY", loadConfigFile().kilo_api_key);
}

export function getOpencodeApiKey(): string | undefined {
	return readAuthJsonKey("opencode", "OPENCODE_API_KEY");
}

// =============================================================================
// Per-provider paid-model flags
// =============================================================================

export function getKiloShowPaid(): boolean {
	return resolveBool("KILO_SHOW_PAID", loadConfigFile().kilo_show_paid);
}

export function getOpencodeShowPaid(): boolean {
	return resolveBool("OPENCODE_SHOW_PAID", loadConfigFile().opencode_show_paid);
}

export function getProviderShowPaid(providerId: string): boolean {
	switch (providerId) {
		case "kilo":
			return getKiloShowPaid();
		case "opencode":
		case "opencode-go":
			return getOpencodeShowPaid();
		default:
			return false;
	}
}

// =============================================================================
// Global free-only mode
// =============================================================================

export function getFreeOnly(): boolean {
	return resolveBool("PI_FREE_MODELS_ONLY", loadConfigFile().free_only);
}

// =============================================================================
// Hidden models
// =============================================================================

/**
 * Apply hidden models filter with provider scoping.
 * Hidden models can be specified as:
 *   - "model-id" (global, applies to all providers)
 *   - "provider/model-id" (provider-specific, preferred)
 */
export function applyHidden<T extends { id: string }>(models: T[], providerId?: string): T[] {
	const hidden = new Set(loadConfigFile().hidden_models ?? []);
	if (hidden.size === 0) return models;

	return models.filter((m) => {
		if (providerId && hidden.has(`${providerId}/${m.id}`)) {
			return false;
		}
		if (hidden.has(m.id)) {
			return false;
		}
		return true;
	});
}

// =============================================================================
// Persistence
// =============================================================================

export function saveConfig(updates: Partial<FreeModelsConfig>): void {
	try {
		const raw = readRawConfigFile();
		if (raw === undefined) {
			const merged = { ...CONFIG_TEMPLATE, ...updates };
			writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
			return;
		}

		let existing: FreeModelsConfig;
		try {
			existing = JSON.parse(raw) as FreeModelsConfig;
		} catch {
			_logger.error(
				"REFUSING to save config — existing file is corrupt. Fix or delete ~/.pi/free-models.json manually.",
				{ path: CONFIG_PATH },
			);
			return;
		}

		const merged = { ...existing, ...updates };
		writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	} catch (err) {
		_logger.error("Failed to save config", {
			path: CONFIG_PATH,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
