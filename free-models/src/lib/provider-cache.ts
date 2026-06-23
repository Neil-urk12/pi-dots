/**
 * Provider model caching for free-models extension.
 *
 * Saves fetched model lists to disk so Pi loads instantly on startup
 * and refreshes in the background when stale (24-hour TTL).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "./logger.ts";
import type { ProviderModelConfig } from "./types.ts";

const _logger = createLogger("provider-cache");

// =============================================================================
// Constants
// =============================================================================

const PI_DIR = join(process.env.HOME || process.env.USERPROFILE || "", ".pi");
const CACHE_DIR = join(PI_DIR, "cache");

/** Default TTL: 24 hours */
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

interface ProviderCacheEntry {
	models: ProviderModelConfig[];
	fetchedAt: number;
	version: 1;
}

// =============================================================================
// Internal helpers
// =============================================================================

function cachePath(providerId: string): string {
	return join(CACHE_DIR, `${providerId}-models.json`);
}

function ensureCacheDir(): void {
	if (!existsSync(CACHE_DIR)) {
		mkdirSync(CACHE_DIR, { recursive: true });
	}
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Load cached models from disk.
 * Returns null if cache is missing, corrupt, or empty.
 */
export function loadProviderCache(providerId: string): ProviderModelConfig[] | null {
	try {
		const path = cachePath(providerId);
		if (!existsSync(path)) return null;

		const raw = readFileSync(path, "utf8");
		const entry = JSON.parse(raw) as ProviderCacheEntry;

		if (!Array.isArray(entry.models) || entry.models.length === 0) {
			return null;
		}

		return entry.models;
	} catch (err) {
		_logger.warn(`Cache read failed for ${providerId}`, {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Save models to disk cache. Fire-and-forget — errors are logged, not thrown.
 */
export async function saveProviderCache(
	providerId: string,
	models: ProviderModelConfig[],
): Promise<void> {
	try {
		ensureCacheDir();
		const entry: ProviderCacheEntry = {
			models,
			fetchedAt: Date.now(),
			version: 1,
		};
		await writeFile(cachePath(providerId), JSON.stringify(entry, null, 2), "utf8");
	} catch (err) {
		_logger.warn(`Cache write failed for ${providerId}`, {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Check if cached models exist and are within the TTL.
 */
export function isProviderCacheFresh(providerId: string, ttlMs: number): boolean {
	try {
		const path = cachePath(providerId);
		if (!existsSync(path)) return false;

		const raw = readFileSync(path, "utf8");
		const entry = JSON.parse(raw) as ProviderCacheEntry;

		if (!Array.isArray(entry.models) || entry.models.length === 0) {
			return false;
		}

		return Date.now() - entry.fetchedAt < ttlMs;
	} catch {
		return false;
	}
}
