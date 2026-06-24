/**
 * Tests for free-model detection and registry logic.
 */
import { describe, it, expect } from "vitest";
import { isFreeModel } from "./registry.ts";
import type { ProviderModelConfig } from "./types.ts";

function makeModel(
	overrides: Partial<ProviderModelConfig & { provider?: string; _pricingKnown?: boolean }> = {},
): ProviderModelConfig & { provider?: string; _pricingKnown?: boolean } {
	return {
		id: "test-model",
		name: "test-model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 4096,
		...overrides,
	};
}

// =============================================================================
// isFreeModel — Route A (pricing-exposed providers)
// =============================================================================
describe("isFreeModel — Route A (pricing-exposed)", () => {
	const allModels = [
		makeModel({ id: "paid", cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 } }),
		makeModel({ id: "free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	];

	it("detects free model by zero cost", () => {
		const model = makeModel({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(isFreeModel(model, allModels)).toBe(true);
	});

	it("detects paid model by non-zero cost", () => {
		const model = makeModel({
			name: "gpt-4o",
			cost: { input: 0.005, output: 0.015, cacheRead: 0, cacheWrite: 0 },
		});
		expect(isFreeModel(model, allModels)).toBe(false);
	});

	it("detects free model by name containing 'free'", () => {
		const model = makeModel({
			name: "llama-3-free",
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
		});
		expect(isFreeModel(model, allModels)).toBe(true);
	});

	it("falls back to name-only when _pricingKnown is false", () => {
		const model = makeModel({
			name: "some-model",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			_pricingKnown: false,
		});
		expect(isFreeModel(model, allModels)).toBe(false);
	});

	it("returns true for name with 'free' when _pricingKnown is false", () => {
		const model = makeModel({
			name: "free-tier-model",
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
			_pricingKnown: false,
		});
		expect(isFreeModel(model, allModels)).toBe(true);
	});
});

// =============================================================================
// isFreeModel — Route B (non-pricing-exposed providers)
// =============================================================================
describe("isFreeModel — Route B (non-pricing-exposed)", () => {
	const allModelsNoPricing = [
		makeModel({
			id: "model-a",
			name: "model-a",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
		makeModel({
			id: "model-b",
			name: "model-b",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}),
	];

	it("detects free model by name in non-pricing provider", () => {
		const model = makeModel({ name: "free-tier" });
		expect(isFreeModel(model, allModelsNoPricing)).toBe(true);
	});

	it("rejects model without 'free' in name for non-pricing provider", () => {
		const model = makeModel({ name: "gpt-4o" });
		expect(isFreeModel(model, allModelsNoPricing)).toBe(false);
	});

	it("is case-insensitive for name matching", () => {
		const model = makeModel({ name: "FREE-model" });
		expect(isFreeModel(model, allModelsNoPricing)).toBe(true);
	});
});

// =============================================================================
// isFreeModel — edge cases
// =============================================================================
describe("isFreeModel — edge cases", () => {
	it("defaults to Route A when no allModels provided", () => {
		const model = makeModel({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(isFreeModel(model)).toBe(true);
	});

	it("defaults to Route A when allModels is empty", () => {
		const model = makeModel({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		expect(isFreeModel(model, [])).toBe(true);
	});

	it("handles model with undefined cost fields", () => {
		const model = makeModel({ cost: undefined as any });
		expect(isFreeModel(model)).toBe(true);
	});
});
