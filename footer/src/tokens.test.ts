import { describe, it, expect } from "vitest";
import { accumulateTotals, accumulateCost } from "./tokens.js";

describe("accumulateTotals", () => {
	it("returns zeros for an empty branch", () => {
		const result = accumulateTotals([]);
		expect(result).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("returns zeros when no assistant messages exist", () => {
		const branch = [
			{ type: "message", message: { role: "user" } },
			{ type: "tool", message: undefined },
		];
		const result = accumulateTotals(branch);
		expect(result).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("accumulates totals from assistant messages", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 200, output: 75, cacheRead: 20, cacheWrite: 8 },
				},
			},
		];
		const result = accumulateTotals(branch);
		expect(result).toEqual({
			input: 300,
			output: 125,
			cacheRead: 30,
			cacheWrite: 13,
		});
	});

	it("handles assistant messages without usage data", () => {
		const branch = [
			{
				type: "message",
				message: { role: "assistant" },
			},
		];
		const result = accumulateTotals(branch);
		expect(result).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("ignores non-message entries", () => {
		const branch = [
			{ type: "bash", message: undefined },
			{
				type: "message",
				message: { role: "assistant", usage: { input: 42, output: 7, cacheRead: 3, cacheWrite: 1 } },
			},
		];
		const result = accumulateTotals(branch);
		expect(result).toEqual({ input: 42, output: 7, cacheRead: 3, cacheWrite: 1 });
	});
});

describe("accumulateCost", () => {
	it("returns 0 for an empty branch", () => {
		const result = accumulateCost([]);
		expect(result).toBe(0);
	});

	it("returns 0 when no assistant messages exist", () => {
		const branch = [
			{ type: "message", message: { role: "user" } },
			{ type: "tool", message: undefined },
		];
		const result = accumulateCost(branch);
		expect(result).toBe(0);
	});

	it("accumulates cost.total from assistant messages", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 5,
						cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0315 },
					},
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 200,
						output: 75,
						cacheRead: 20,
						cacheWrite: 8,
						cost: { input: 0.02, output: 0.03, cacheRead: 0.002, cacheWrite: 0.0008, total: 0.0528 },
					},
				},
			},
		];
		const result = accumulateCost(branch);
		expect(result).toBeCloseTo(0.0843, 4);
	});

	it("returns 0 when assistant messages have no usage.cost", () => {
		const branch = [
			{
				type: "message",
				message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
			},
		];
		const result = accumulateCost(branch);
		expect(result).toBe(0);
	});

	it("handles negative cost.total as 0", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: -0.01 },
					},
				},
			},
		];
		const result = accumulateCost(branch);
		expect(result).toBe(0);
	});

	it("ignores NaN and Infinity cost.total", () => {
		const branch = [
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: NaN },
					},
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: {
						input: 200,
						output: 75,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Infinity },
					},
				},
			},
		];
		const result = accumulateCost(branch);
		expect(result).toBe(0);
	});
});
