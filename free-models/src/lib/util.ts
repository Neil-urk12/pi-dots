/**
 * Shared utilities for free-models extension.
 */

import { createLogger } from "./logger.ts";
import type { ProviderModelConfig } from "./types.ts";

const _logger = createLogger("util");

// =============================================================================
// Fetch with retry
// =============================================================================

/**
 * Fetch with timeout using AbortController
 */
export async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs = 30000,
): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, {
			...options,
			signal: controller.signal,
		});
		return response;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Fetch with retry logic and timeout
 */
export async function fetchWithRetry(
	url: string,
	options: RequestInit,
	retries = 3,
	delayMs = 1000,
	timeoutMs = 30000,
): Promise<Response> {
	let lastError: unknown;

	for (let i = 0; i < retries; i++) {
		try {
			const response = await fetchWithTimeout(url, options, timeoutMs);
			if (response.ok) return response;

			if (response.status === 429) {
				throw new Error(`Rate limited (429)`);
			}

			if (response.status >= 500) {
				lastError = new Error(`Server error ${response.status}`);
				if (i < retries - 1) {
					await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
					continue;
				}
				throw lastError;
			}

			return response;
		} catch (error) {
			lastError = error;
			if (i < retries - 1) {
				await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
			}
		}
	}

	throw lastError;
}

// =============================================================================
// Model name cleaning
// =============================================================================

/**
 * Strip provider prefix from model names.
 * Handles "Provider : Model Name" or "Provider / Model Name" patterns.
 */
export function cleanModelName(name: string): string {
	const colonIdx = name.indexOf(":");
	const slashIdx = name.indexOf("/");
	const idx = colonIdx === -1 ? slashIdx : slashIdx === -1 ? colonIdx : Math.min(colonIdx, slashIdx);
	if (idx > 0) {
		return name.slice(idx + 1).trim();
	}
	return name.trim();
}

// =============================================================================
// Model mapping
// =============================================================================

/**
 * Map an OpenRouter-compatible API model to ProviderModelConfig.
 * Used by both Kilo and OpenRouter providers.
 */
export function mapOpenRouterModel(m: {
	id: string;
	name: string;
	context_length?: number;
	max_completion_tokens?: number | null;
	top_provider?: { max_completion_tokens?: number | null };
	pricing?: { prompt?: string | null; completion?: string | null };
	architecture?: {
		input_modalities?: string[] | null;
		output_modalities?: string[] | null;
	};
}): ProviderModelConfig {
	const promptPrice = Number.parseFloat(m.pricing?.prompt ?? "0");
	const completionPrice = Number.parseFloat(m.pricing?.completion ?? "0");
	const contextWindow = m.context_length ?? 4096;
	let maxTokens = m.max_completion_tokens ?? m.top_provider?.max_completion_tokens ?? 4096;

	if (maxTokens > 16384 && maxTokens >= contextWindow) {
		maxTokens = 16384;
	}

	return {
		id: m.id,
		name: cleanModelName(m.name),
		reasoning: false,
		input: m.architecture?.input_modalities?.includes("image")
			? (["text", "image"] as const)
			: (["text"] as const),
		cost: {
			input: promptPrice,
			output: completionPrice,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
		_pricingKnown: true,
	};
}

// =============================================================================
// API response parsing
// =============================================================================

/**
 * Parse and validate model list API response
 */
export async function parseModelResponse<T>(
	response: Response,
	providerName: string,
): Promise<{ data: T[] }> {
	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${providerName} models: ${response.status} ${response.statusText}`,
		);
	}

	const json = (await response.json()) as { data?: T[] };

	if (!json.data || !Array.isArray(json.data)) {
		throw new Error(`Invalid ${providerName} models response: missing data array`);
	}

	return { data: json.data };
}

// =============================================================================
// Log warning helper
// =============================================================================

export function logWarning(provider: string, message: string, error?: unknown): void {
	_logger.warn(`[${provider}] ${message}`, error ? { error: String(error) } : undefined);
}

// =============================================================================
// OpenCode Model Context Windows
// =============================================================================

const OPENCODE_FREE_CONTEXT_LIMITS: Record<string, number> = {
	"deepseek-v4-flash-free": 256000,
	"mimo-v2.5-free": 256000,
	"north-mini-code-free": 256000,
	"qwen3.6-plus-free": 1000000,
	"minimax-m3-free": 1048576,
	"nemotron-3-ultra-free": 1000000,
};

/**
 * Get accurate context window limit for OpenCode free models.
 */
export function getOpenCodeModelContextWindow(modelId: string): number {
	const id = modelId.toLowerCase();
	return OPENCODE_FREE_CONTEXT_LIMITS[id] ?? 128000;
}
