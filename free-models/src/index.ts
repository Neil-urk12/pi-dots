/**
 * Free-Models Extension for Pi
 *
 * Provides free model filtering for Kilo and OpenCode providers.
 * Uses separate config (~/.pi/free-models.json) to avoid conflicts with pi-free.
 *
 * Commands:
 *   /toggle-free        - Global free-only mode toggle
 *   /free-providers     - Show provider stats
 *   /toggle-kilo        - Toggle Kilo free/all models
 *   /toggle-opencode    - Toggle OpenCode free/all models
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLogger } from "./lib/logger.ts";
import { applyGlobalFilter, getGlobalFreeOnly, getProviderRegistry } from "./lib/registry.ts";
import kilo from "./providers/kilo.ts";
import opencode from "./providers/opencode.ts";

const _logger = createLogger("free-models");

// =============================================================================
// Global Commands
// =============================================================================

function setupGlobalCommands(pi: ExtensionAPI) {
	// /toggle-free - Global free-only mode toggle
	pi.registerCommand("toggle-free", {
		description: "Toggle global free-only mode for all providers",
		handler: async (_args, ctx) => {
			const current = getGlobalFreeOnly();
			const next = !current;
			applyGlobalFilter(pi, next, { force: true });

			const registry = getProviderRegistry();
			const providerCount = registry.size;

			if (next) {
				const totalFree = [...registry.values()].reduce((sum, e) => sum + e.stored.free.length, 0);
				ctx.ui.notify(
					`Free-only mode: ON (${totalFree} free models across ${providerCount} providers)`,
					"info",
				);
			} else {
				const totalAll = [...registry.values()].reduce(
					(sum, e) => sum + (e.stored.all.length || e.stored.free.length),
					0,
				);
				ctx.ui.notify(
					`Free-only mode: OFF (all ${totalAll} models visible across ${providerCount} providers)`,
					"info",
				);
			}
		},
	});

	// /free-providers - Show free model counts by provider
	pi.registerCommand("free-providers", {
		description: "Show free/paid model counts for all free-models providers",
		handler: async (_args, ctx) => {
			const lines = ["Free-Models Providers:", ""];
			const registry = getProviderRegistry();

			for (const [id, entry] of registry) {
				const free = entry.stored.free.length;
				const all = entry.stored.all.length || free;
				const indicator = entry.hasKey ? "[key]" : "[free]";
				const paid = all - free;

				if (paid === 0 && free > 0) {
					lines.push(`${indicator} ${id}: ${free} free models`);
				} else {
					lines.push(`${indicator} ${id}: ${free} free / ${paid} paid (${all} total)`);
				}
			}

			if (registry.size === 0) {
				lines.push("(No providers registered yet)");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

// =============================================================================
// Main Entry Point
// =============================================================================

export default async function freeModelsEntry(pi: ExtensionAPI) {
	const globalFreeOnly = getGlobalFreeOnly();
	_logger.info(`Initializing (global free-only: ${globalFreeOnly})`);

	// Setup global commands
	setupGlobalCommands(pi);

	// Load providers (concurrent)
	await Promise.allSettled([kilo(pi), opencode(pi)]);

	// Apply initial global filter if free-only mode is enabled
	if (globalFreeOnly) {
		_logger.info("Applying initial free-only filter");
		applyGlobalFilter(pi, true);
	}

	const registry = getProviderRegistry();
	_logger.info(`Loaded with ${registry.size} providers`);
}

// Re-export registry helpers so consumers don't need deep imports
export {
	applyGlobalFilter,
	getGlobalFreeOnly,
	getProviderRegistry,
	isFreeModel,
	registerWithGlobalToggle,
};
