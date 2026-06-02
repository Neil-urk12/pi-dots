/**
 * Shared types for free-models extension.
 */

// =============================================================================
// Provider model configuration (matches Pi's ProviderModelConfig)
// =============================================================================

export interface CostConfig {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ProviderModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: CostConfig;
	contextWindow: number;
	maxTokens: number;
	/** Internal flag: true when API returned real pricing data */
	_pricingKnown?: boolean;
}

// =============================================================================
// OpenRouter API response types
// =============================================================================

export interface OpenRouterPricing {
	prompt?: string | null;
	completion?: string | null;
	input_cache_write?: string | null;
	input_cache_read?: string | null;
}

export interface OpenRouterArchitecture {
	input_modalities?: string[] | null;
	output_modalities?: string[] | null;
}

export interface OpenRouterTopProvider {
	max_completion_tokens?: number | null;
}

export interface OpenRouterModel {
	id: string;
	name: string;
	context_length: number;
	max_completion_tokens?: number | null;
	pricing?: OpenRouterPricing;
	architecture?: OpenRouterArchitecture;
	top_provider?: OpenRouterTopProvider;
	supported_parameters?: string[];
}

// =============================================================================
// models.dev schema types
// =============================================================================

export interface ModelsDevCost {
	input: number;
	output: number;
	cache_read?: number;
	cache_write?: number;
}

export interface ModelsDevLimit {
	context: number;
	output: number;
}

export interface ModelsDevModalities {
	input?: string[];
	output?: string[];
}

export interface ModelsDevModel {
	id: string;
	name: string;
	reasoning: boolean;
	cost?: ModelsDevCost;
	limit: ModelsDevLimit;
	modalities?: ModelsDevModalities;
}

// =============================================================================
// Zen gateway types (OpenCode uses this shape)
// =============================================================================

export interface ZenGatewayModel {
	id: string;
	object?: string;
}
