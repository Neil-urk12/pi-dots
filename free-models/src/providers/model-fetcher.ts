/**
 * Shared model fetching for OpenRouter-compatible APIs.
 */

import type { ProviderModelConfig } from "../lib/types.ts";
import { fetchWithRetry, mapOpenRouterModel } from "../lib/util.ts";

interface OpenRouterCompatibleModel {
	id: string;
	name: string;
	context_length: number;
	max_completion_tokens?: number | null;
	pricing?: {
		prompt?: string | null;
		completion?: string | null;
		input_cache_read?: string | null;
		input_cache_write?: string | null;
	};
	architecture?: {
		input_modalities?: string[] | null;
		output_modalities?: string[] | null;
	};
	top_provider?: { max_completion_tokens?: number | null };
	supported_parameters?: string[];
}

interface FetchModelsOptions {
	baseUrl: string;
	apiKey?: string;
	freeOnly?: boolean;
	extraHeaders?: Record<string, string>;
	retries?: number;
	retryDelay?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetch models from an OpenRouter-compatible API.
 * Handles response parsing, filtering, and mapping to ProviderModelConfig.
 */
export async function fetchOpenRouterCompatibleModels(
	options: FetchModelsOptions,
): Promise<ProviderModelConfig[]> {
	const {
		baseUrl,
		apiKey,
		freeOnly = false,
		extraHeaders = {},
		retries = 3,
		retryDelay = 1000,
	} = options;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"User-Agent": "pi-free-providers",
		...extraHeaders,
	};

	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const response = await fetchWithRetry(
		`${baseUrl}/models`,
		{
			headers,
			signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
		},
		retries,
		retryDelay,
		DEFAULT_FETCH_TIMEOUT_MS,
	);

	if (!response.ok) {
		throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
	}

	const json = (await response.json()) as {
		data?: OpenRouterCompatibleModel[];
	};

	if (!json.data || !Array.isArray(json.data)) {
		throw new Error("Invalid models response: missing data array");
	}

	return json.data
		.filter((m) => {
			const outputMods = m.architecture?.output_modalities ?? [];
			if (outputMods.includes("image")) return false;

			if (freeOnly) {
				const prompt = Number.parseFloat(m.pricing?.prompt ?? "1");
				const completion = Number.parseFloat(m.pricing?.completion ?? "1");
				if (prompt !== 0 || completion !== 0) return false;
			}

			return true;
		})
		.map(mapOpenRouterModel);
}
