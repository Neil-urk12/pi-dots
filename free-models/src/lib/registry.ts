/**
 * Global Provider Registry for free-models extension.
 *
 * Decoupled from index.ts so providers can import toggle logic
 * without creating a circular dependency.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getFreeOnly, getProviderShowPaid, saveConfig } from "../config.ts";
import { createLogger } from "./logger.ts";

const _logger = createLogger("registry");

// =============================================================================
// Types
// =============================================================================

interface ProviderEntry {
	id: string;
	stored: { free: ProviderModelConfig[]; all: ProviderModelConfig[] };
	reRegister: (models: ProviderModelConfig[]) => void;
	hasKey: boolean;
}

// =============================================================================
// State
// =============================================================================

const providerRegistry = new Map<string, ProviderEntry>();
let globalFreeOnly = getFreeOnly();

// =============================================================================
// Free-model detection
// =============================================================================

/**
 * Detect if a provider exposes actual per-model pricing.
 *
 * Heuristic: if ALL models have cost === 0, the provider likely doesn't expose
 * real pricing (cost was defaulted to 0). If SOME models have cost > 0, the
 * provider definitely exposes pricing.
 */
function detectPricingExposed(allModels: ProviderModelConfig[]): boolean {
	if (allModels.length === 0) return false;
	return allModels.some((m) => (m.cost?.input ?? 0) > 0 || (m.cost?.output ?? 0) > 0);
}

/**
 * Check if a model is free using adaptive Route A/B logic.
 *
 * **Route A (Pricing-Exposed Providers):** Uses cost-based detection.
 *   - Free = cost.input === 0 && cost.output === 0, OR name contains "free"
 *   - When _pricingKnown is explicitly false, falls back to name-only
 *
 * **Route B (Non-Pricing-Exposed Providers):** Uses name-based detection only.
 *   - Free = model name contains "free" (case-insensitive)
 *
 * @param model - The model config to check
 * @param allModels - Optional: all models from the same provider for detection
 * @returns true if the model is definitively free per the provider's API
 */
export function isFreeModel(
	model: ProviderModelConfig & { provider?: string; _pricingKnown?: boolean },
	allModels?: ProviderModelConfig[],
): boolean {
	let pricingExposed: boolean;

	if (allModels && allModels.length > 0) {
		pricingExposed = detectPricingExposed(allModels);
	} else {
		pricingExposed = true;
	}

	// Route A: Pricing-exposed providers
	if (pricingExposed) {
		const isZeroCost = (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0;
		const hasFreeInName = model.name.toLowerCase().includes("free");

		// Pricing missing for this specific model — only trust name-based signal
		if (model._pricingKnown === false) {
			return hasFreeInName;
		}

		return isZeroCost || hasFreeInName;
	}

	// Route B: Non-pricing-exposed providers — name-based only
	return model.name.toLowerCase().includes("free");
}

// =============================================================================
// Registration
// =============================================================================

/** Register a provider with the global free/paid toggle system */
export function registerWithGlobalToggle(
	providerId: string,
	stored: { free: ProviderModelConfig[]; all: ProviderModelConfig[] },
	reRegister: (models: ProviderModelConfig[]) => void,
	hasKey: boolean = false,
): void {
	providerRegistry.set(providerId, {
		id: providerId,
		stored,
		reRegister,
		hasKey,
	});
	_logger.info(
		`Registered ${providerId} with global toggle (${stored.free.length} free, ${stored.all.length} total)`,
	);
}

/** Get current global free-only state */
export function getGlobalFreeOnly(): boolean {
	return globalFreeOnly;
}

/** Access the raw registry (used by /free-providers command) */
export function getProviderRegistry(): ReadonlyMap<string, ProviderEntry> {
	return providerRegistry;
}

// =============================================================================
// Global filter application
// =============================================================================

function showAllForProvider(providerId: string, entry: ProviderEntry): void {
	const allModels = entry.stored.all.length > 0 ? entry.stored.all : entry.stored.free;
	if (allModels.length > 0) {
		entry.reRegister(allModels);
		_logger.info(`${providerId}: showing all ${allModels.length} models`);
	}
}

function applyFilterToProvider(
	providerId: string,
	entry: ProviderEntry,
	freeOnly: boolean,
	force: boolean,
): void {
	if (freeOnly) {
		if (!force && getProviderShowPaid(providerId)) {
			showAllForProvider(providerId, entry);
			_logger.info(`${providerId}: preserved persisted all-models toggle`);
			return;
		}

		if (entry.stored.free.length > 0) {
			entry.reRegister(entry.stored.free);
			_logger.info(`${providerId}: filtered to ${entry.stored.free.length} free models`);
		} else {
			_logger.warn(`${providerId}: no free models available`);
		}
	} else {
		showAllForProvider(providerId, entry);
	}
}

export function applyGlobalFilter(
	_pi: ExtensionAPI,
	freeOnly: boolean,
	options: { force?: boolean } = {},
): void {
	globalFreeOnly = freeOnly;
	saveConfig({ free_only: freeOnly });

	for (const [providerId, entry] of providerRegistry) {
		try {
			applyFilterToProvider(providerId, entry, freeOnly, options.force === true);
		} catch (err) {
			_logger.error(
				`Failed to apply filter to ${providerId}`,
				err instanceof Error ? { error: err.message } : { error: String(err) },
			);
		}
	}
}
