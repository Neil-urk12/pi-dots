import { describe, it, expect } from "vitest";
import { accumulateTotals } from "./tokens.js";

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
