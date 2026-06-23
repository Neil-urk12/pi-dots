/**
 * Kilo Provider for free-models extension.
 *
 * Provides access to 300+ AI models via the Kilo Gateway (OpenRouter-compatible).
 * Fetches ALL models at startup, defaults to free-only view.
 * Use /toggle-kilo to access paid models.
 *
 * Responds to global free-only filter for free/paid model filtering.
 */

import type { Api, Model, OAuthCredentials } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getKiloShowPaid, saveConfig } from "../config.ts";
import { isFreeModel, registerWithGlobalToggle } from "../lib/registry.ts";
import {
	loadProviderCache,
	saveProviderCache,
	isProviderCacheFresh,
	DEFAULT_CACHE_TTL_MS,
} from "../lib/provider-cache.ts";
import { logWarning } from "../lib/util.ts";
import { fetchKiloModels, KILO_GATEWAY_BASE } from "./kilo-models.ts";
import { loginKilo, refreshKiloToken } from "./kilo-auth.ts";

const PROVIDER_KILO = "kilo";

export default async function kiloProvider(pi: ExtensionAPI) {
	let allModels: ProviderModelConfig[] = [];
	let freeModels: ProviderModelConfig[] = [];

	// Fetch models at startup (cache-first)
	const cachedModels = loadProviderCache(PROVIDER_KILO);
	if (cachedModels && cachedModels.length > 0) {
		allModels = cachedModels;
	} else {
		try {
			allModels = await fetchKiloModels({ freeOnly: false });
			if (allModels.length > 0) {
				saveProviderCache(PROVIDER_KILO, allModels).catch((err) => {
					logWarning("kilo", "Failed to save model cache", err);
				});
			}
		} catch (error) {
			logWarning("kilo", "Failed to fetch models at startup", error);
			try {
				freeModels = await fetchKiloModels({ freeOnly: true });
			} catch (e) {
				logWarning("kilo", "Failed to fetch free models", e);
			}
		}
	}
	freeModels = allModels.filter((m) => isFreeModel({ ...m, provider: PROVIDER_KILO }, allModels));

	const kiloShowPaid = getKiloShowPaid();
	let showPaidModels = kiloShowPaid;
	let currentModels = kiloShowPaid && allModels.length > 0 ? allModels : freeModels;

	// Re-register function: re-registers provider with given model set
	const reRegister = (models: ProviderModelConfig[]) => {
		pi.registerProvider(PROVIDER_KILO, {
			baseUrl: KILO_GATEWAY_BASE,
			apiKey: "free",
			api: "openai-completions" as const,
			headers: {
				"X-KILOCODE-EDITORNAME": "Pi",
				"User-Agent": "pi-free-providers",
			},
			models,
			oauth: oauthConfig,
		});
	};

	// OAuth config for Kilo
	const oauthConfig = {
		name: "Kilo",
		login: async (callbacks: OAuthLoginCallbacks) => {
			const cred = await loginKilo(callbacks);
			try {
				const newModels = await fetchKiloModels({
					token: cred.access,
					freeOnly: false,
				});
				allModels = newModels;
				stored.all = allModels;
				freeModels = allModels.filter((m) => isFreeModel({ ...m, provider: PROVIDER_KILO }, allModels));
				stored.free = freeModels;

				registerWithGlobalToggle(PROVIDER_KILO, stored, reRegister, true);

				if (showPaidModels) {
					currentModels = allModels;
					reRegister(allModels);
				}
			} catch (error) {
				logWarning("kilo", "Failed to fetch models after login", error);
			}
			return cred;
		},
		refreshToken: refreshKiloToken,
		getApiKey: (cred: OAuthCredentials) => cred.access,
		modifyModels: (models: Model<Api>[]) => {
			if (!showPaidModels || allModels.length === 0) {
				return models;
			}
			const template = models.find((m) => m.provider === PROVIDER_KILO);
			if (!template) return models;
			const nonKilo = models.filter((m) => m.provider !== PROVIDER_KILO);
			const fullModels = allModels.map((m) => ({
				...template,
				id: m.id,
				name: m.name,
				reasoning: m.reasoning,
				input: m.input,
				cost: m.cost,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
			}));
			return [...nonKilo, ...fullModels];
		},
	};

	// Shared model storage for global toggle
	const stored = { free: freeModels, all: allModels };

	// Register with global toggle system
	registerWithGlobalToggle(PROVIDER_KILO, stored, reRegister, !!process.env.KILO_API_KEY);

	// Register initial provider (default to free models)
	pi.registerProvider(PROVIDER_KILO, {
		baseUrl: KILO_GATEWAY_BASE,
		apiKey: "free",
		api: "openai-completions" as const,
		headers: {
			"X-KILOCODE-EDITORNAME": "Pi",
			"User-Agent": "pi-free-providers",
		},
		models: currentModels,
		oauth: oauthConfig,
	});

	// Per-provider toggle command
	pi.registerCommand("toggle-kilo", {
		description: "Toggle between free and all Kilo models",
		handler: async (_args, ctx) => {
			showPaidModels = !showPaidModels;
			saveConfig({ kilo_show_paid: showPaidModels });

			const modelsToShow = showPaidModels && allModels.length > 0 ? allModels : freeModels;

			currentModels = modelsToShow;
			reRegister(modelsToShow);

			const freeCount = freeModels.length;
			const paidCount = allModels.length - freeCount;

			if (showPaidModels && allModels.length > 0) {
				ctx.ui.notify(
					`kilo: showing all ${allModels.length} models (${freeCount} free, ${paidCount} paid)`,
					"info",
				);
			} else {
				ctx.ui.notify(`kilo: showing ${freeCount} free models (${paidCount} paid hidden)`, "info");
			}
		},
	});

	// Status bar on provider selection
	let tosShown = false;
	pi.on("model_select", async (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_KILO) {
			ctx.ui.setStatus(`${PROVIDER_KILO}-status`, undefined);
			return;
		}

		const free = freeModels.length;
		const total = allModels.length;
		const paid = total - free;
		let status: string;
		if (paid === 0) {
			status = `kilo: ${free} free models`;
		} else if (showPaidModels) {
			status = `kilo: ${total} models (free + paid)`;
		} else {
			status = `kilo: ${free} free · ${paid} paid`;
		}
		ctx.ui.setStatus(`${PROVIDER_KILO}-status`, status);

		// ToS notice (once)
		if (tosShown) return;
		tosShown = true;
		const cred = ctx.modelRegistry.authStorage.get(PROVIDER_KILO);
		if (cred?.type === "oauth") return;
		const paidCount = allModels.length - freeModels.length;
		if (paidCount > 0) {
			ctx.ui.notify(
				`Kilo: ${freeModels.length} free models shown. Use /toggle-kilo or /login kilo for ${paidCount} paid models.`,
				"info",
			);
		}
	});

	// Refresh models on session start (background, non-blocking)
	let refreshInFlight: Promise<void> | undefined;
	pi.on("session_start", async (_event, ctx) => {
		if (refreshInFlight) return;

		const cred = ctx.modelRegistry.authStorage.get(PROVIDER_KILO);
		const isAuth = cred?.type === "oauth";
		const cacheStale = !isProviderCacheFresh(PROVIDER_KILO, DEFAULT_CACHE_TTL_MS);

		// Skip if cache is fresh and not authenticated (nothing to refresh)
		if (!isAuth && !cacheStale) return;

		refreshInFlight = (async () => {
			try {
				const newModels = await fetchKiloModels({
					token: isAuth ? cred.access : undefined,
					freeOnly: false,
				});
				if (newModels.length > 0) {
					allModels = newModels;
					stored.all = allModels;
					freeModels = allModels.filter((m) =>
						isFreeModel({ ...m, provider: PROVIDER_KILO }, allModels),
					);
					stored.free = freeModels;
					await saveProviderCache(PROVIDER_KILO, allModels);

					registerWithGlobalToggle(PROVIDER_KILO, stored, reRegister, isAuth);

					reRegister(showPaidModels ? allModels : freeModels);
				}
			} catch (error) {
				logWarning("kilo", "Failed to refresh models at session start", error);
			} finally {
				refreshInFlight = undefined;
			}
		})();
	});
}

// Minimal OAuthLoginCallbacks type (matches pi-ai's interface)
interface OAuthLoginCallbacks {
	onProgress?: (msg: string) => void;
	onAuth: (info: { url: string; instructions: string }) => void;
	signal?: AbortSignal;
}
