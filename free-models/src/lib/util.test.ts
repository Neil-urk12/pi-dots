/**
 * Tests for shared utility functions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanModelName, mapOpenRouterModel, fetchWithRetry } from "./util.ts";

// =============================================================================
// cleanModelName
// =============================================================================
describe("cleanModelName", () => {
	it("strips provider prefix with colon", () => {
		expect(cleanModelName("OpenAI : GPT-4o")).toBe("GPT-4o");
	});

	it("strips provider prefix with slash", () => {
		expect(cleanModelName("Anthropic/Claude 3.5 Sonnet")).toBe("Claude 3.5 Sonnet");
	});

	it("strips prefix with first delimiter when both present", () => {
		expect(cleanModelName("Provider : Model/Name")).toBe("Model/Name");
	});

	it("returns name unchanged when no prefix", () => {
		expect(cleanModelName("gpt-4o")).toBe("gpt-4o");
	});

	it("trims whitespace", () => {
		expect(cleanModelName("  gpt-4o  ")).toBe("gpt-4o");
	});

	it("handles empty string", () => {
		expect(cleanModelName("")).toBe("");
	});

	it("handles colon at start (idx=0)", () => {
		expect(cleanModelName(":model")).toBe(":model");
	});
});

// =============================================================================
// mapOpenRouterModel
// =============================================================================
describe("mapOpenRouterModel", () => {
	it("maps basic model with pricing", () => {
		const result = mapOpenRouterModel({
			id: "openai/gpt-4o",
			name: "OpenAI : GPT-4o",
			context_length: 128000,
			max_completion_tokens: 16384,
			pricing: { prompt: "0.005", completion: "0.015" },
			architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		});

		expect(result.id).toBe("openai/gpt-4o");
		expect(result.name).toBe("GPT-4o");
		expect(result.reasoning).toBe(false);
		expect(result.input).toEqual(["text"]);
		expect(result.cost.input).toBe(0.005);
		expect(result.cost.output).toBe(0.015);
		expect(result.contextWindow).toBe(128000);
		expect(result.maxTokens).toBe(16384);
		expect(result._pricingKnown).toBe(true);
	});

	it("detects image input modality", () => {
		const result = mapOpenRouterModel({
			id: "model",
			name: "model",
			architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		});
		expect(result.input).toEqual(["text", "image"]);
	});

	it("defaults missing pricing to 0", () => {
		const result = mapOpenRouterModel({ id: "m", name: "m" });
		expect(result.cost.input).toBe(0);
		expect(result.cost.output).toBe(0);
	});

	it("falls back to top_provider.max_completion_tokens", () => {
		const result = mapOpenRouterModel({
			id: "m",
			name: "m",
			top_provider: { max_completion_tokens: 8192 },
		});
		expect(result.maxTokens).toBe(8192);
	});

	it("falls back to 4096 when no max_tokens info", () => {
		const result = mapOpenRouterModel({ id: "m", name: "m" });
		expect(result.maxTokens).toBe(4096);
		expect(result.contextWindow).toBe(4096);
	});

	it("handles null pricing strings", () => {
		const result = mapOpenRouterModel({
			id: "m",
			name: "m",
			pricing: { prompt: null, completion: null },
		});
		expect(result.cost.input).toBe(0);
		expect(result.cost.output).toBe(0);
	});

	it("caps maxTokens to 16384 when it equals or exceeds contextWindow and maxTokens > 16384", () => {
		const result = mapOpenRouterModel({
			id: "stepfun/step-3.7-flash:free",
			name: "Step 3.7 Flash",
			context_length: 262144,
			max_completion_tokens: 262144,
		});
		expect(result.contextWindow).toBe(262144);
		expect(result.maxTokens).toBe(16384);
	});

	it("does not cap maxTokens when maxTokens <= 16384 even if it equals or exceeds contextWindow", () => {
		const result = mapOpenRouterModel({
			id: "m",
			name: "m",
			context_length: 4096,
			max_completion_tokens: 4096,
		});
		expect(result.contextWindow).toBe(4096);
		expect(result.maxTokens).toBe(4096);
	});
});

// =============================================================================
// fetchWithRetry
// =============================================================================
describe("fetchWithRetry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns successful response immediately", async () => {
		const mockResponse = { ok: true, status: 200 } as Response;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

		const result = await fetchWithRetry("https://example.com", {});
		expect(result).toBe(mockResponse);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it("retries on 500 errors", async () => {
		const failResponse = { ok: false, status: 500 } as Response;
		const okResponse = { ok: true, status: 200 } as Response;
		vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(failResponse)
			.mockResolvedValueOnce(okResponse);

		const promise = fetchWithRetry("https://example.com", {}, 3, 100);
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;
		expect(result).toBe(okResponse);
	});

	it("throws immediately on 429 (rate limit)", async () => {
		vi.useRealTimers();
		const rateLimitResponse = { ok: false, status: 429 } as Response;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(rateLimitResponse);

		await expect(fetchWithRetry("https://example.com", {}, 3, 100)).rejects.toThrow(
			"Rate limited (429)",
		);
	});

	it("returns non-ok response for 4xx (not 429)", async () => {
		const clientError = { ok: false, status: 404 } as Response;
		vi.spyOn(globalThis, "fetch").mockResolvedValue(clientError);

		const result = await fetchWithRetry("https://example.com", {});
		expect(result.status).toBe(404);
	});

	it("throws after exhausting retries on network error", async () => {
		vi.useRealTimers();
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network failure"));

		await expect(fetchWithRetry("https://example.com", {}, 2, 10)).rejects.toThrow("Network failure");
	});
});
