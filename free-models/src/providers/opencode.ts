/**
 * OpenCode Provider for free-models extension.
 *
 * Registers both "opencode" and "opencode-go" providers.
 * OpenCode requires special headers (x-opencode-session, x-opencode-request)
 * that must be regenerated per-request via a custom streamSimple.
 *
 * Use /toggle-opencode to switch between free and all models.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getOpencodeApiKey, getOpencodeShowPaid, saveConfig } from "../config.ts";
import { isFreeModel, registerWithGlobalToggle } from "../lib/registry.ts";
import { logWarning } from "../lib/util.ts";
import { createOpenCodeStreamSimple, createOpenCodeSessionTracker } from "./opencode-session.ts";

const OPENCODE_BASES = [
	{ providerId: "opencode", baseUrl: "https://opencode.ai/zen/v1" },
	{ providerId: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" },
] as const;

// Shared session tracker for all OpenCode endpoints
const opencodeSession = createOpenCodeSessionTracker();

// =============================================================================
// Model fetching
// =============================================================================

interface OpenCodeRawModel {
	id: string;
	object?: string;
}

async function fetchOpenCodeModels(
	baseUrl: string,
	apiKey: string,
): Promise<ProviderModelConfig[]> {
	let cleanBase = baseUrl;
	while (cleanBase.endsWith("/")) cleanBase = cleanBase.slice(0, -1);

	const response = await fetch(`${cleanBase}/models`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		throw new Error(`OpenCode API error: ${response.status} ${response.statusText}`);
	}

	const body = (await response.json()) as OpenCodeRawModel[] | { data?: OpenCodeRawModel[] };
	const rawModels = Array.isArray(body) ? body : (body.data ?? []);

	return rawModels.map((m) => ({
		id: m.id,
		name: m.id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		_pricingKnown: false,
	}));
}

// =============================================================================
// Provider entry point
// =============================================================================

export default async function opencodeProvider(pi: ExtensionAPI) {
	const apiKey = getOpencodeApiKey();
	if (!apiKey) return;

	const showPaid = getOpencodeShowPaid();
	const streamSimple = createOpenCodeStreamSimple(opencodeSession);

	// Register each endpoint (opencode + opencode-go)
	for (const { providerId, baseUrl } of OPENCODE_BASES) {
		let allModels: ProviderModelConfig[] = [];
		let freeModels: ProviderModelConfig[] = [];

		try {
			allModels = await fetchOpenCodeModels(baseUrl, apiKey);
			freeModels = allModels.filter((m) =>
				isFreeModel({ ...m, provider: providerId, _pricingKnown: false }, allModels),
			);
		} catch (error) {
			logWarning(providerId, "Failed to fetch models at startup", error);
			continue;
		}

		if (allModels.length === 0) continue;

		let showPaidModels = showPaid;
		let currentModels = showPaidModels ? allModels : freeModels;

		const stored = { free: freeModels, all: allModels };

		// Re-register function
		const reRegister = (models: ProviderModelConfig[]) => {
			pi.registerProvider(providerId, {
				baseUrl,
				apiKey,
				api: "openai-completions" as const,
				models,
				streamSimple,
			});
		};

		// Register with global toggle
		registerWithGlobalToggle(providerId, stored, reRegister, true);

		// Register initial provider
		pi.registerProvider(providerId, {
			baseUrl,
			apiKey,
			api: "openai-completions" as const,
			models: currentModels,
			streamSimple,
		});

		// Status bar
		const pid = providerId;
		pi.on("model_select", (_event, ctx) => {
			if (ctx.model?.provider !== pid) {
				ctx.ui.setStatus(`${pid}-status`, undefined);
				return;
			}

			const f = freeModels.length;
			const t = allModels.length;
			const p = t - f;
			let status: string;
			if (p === 0) {
				status = `${pid}: ${f} free models`;
			} else if (showPaidModels) {
				status = `${pid}: ${t} models (free + paid)`;
			} else {
				status = `${pid}: ${f} free · ${p} paid`;
			}
			ctx.ui.setStatus(`${pid}-status`, `${status} 🔑`);
		});
	}

	// Shared toggle command for both opencode and opencode-go
	pi.registerCommand("toggle-opencode", {
		description: "Toggle between free and all OpenCode models",
		handler: async (_args, ctx) => {
			const current = getOpencodeShowPaid();
			const next = !current;
			saveConfig({ opencode_show_paid: next });

			// Re-register both endpoints
			for (const { providerId, baseUrl } of OPENCODE_BASES) {
				const entry = getProviderRegistry().get(providerId);
				if (!entry) continue;

				const models = next ? entry.stored.all : entry.stored.free;
				if (models.length > 0) {
					entry.reRegister(models);
				}
			}

			if (next) {
				ctx.ui.notify(`opencode: showing all models`, "info");
			} else {
				ctx.ui.notify(`opencode: showing free models only`, "info");
			}
		},
	});
}

// Re-export for use by toggle command
import { getProviderRegistry } from "../lib/registry.ts";
