import { describe, it, expect } from "vitest";
import { renderFooter } from "./renderer.js";
import type { FooterInput, Theme, Totals } from "./types.js";
import { defaultConfig as baseDefaultConfig } from "./configPresets.js";
import type { ResolvedConfig } from "./configTypes.js";

const plainTheme = {
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

const captureTheme = {
	fg: (name: string, text: string) => `[${name}:${text}]`,
} as unknown as Theme;

const defaultConfig: ResolvedConfig = {
	...baseDefaultConfig,
};

function makeInput(
	overrides?: Partial<FooterInput> & {
		configOverrides?: Partial<ResolvedConfig>;
	},
): FooterInput {
	const { configOverrides, ...rest } = overrides ?? {};
	return {
		modelId: "anthropic/claude-sonnet-4-20250514",
		thinkingLevel: undefined,
	directory: "my-project",
		gitBranch: "main",
		gitDirtyCount: 0,
		contextUsed: 50_000,
		contextMax: 200_000,
		totals: { input: 1500, output: 500, cacheRead: 200, cacheWrite: 100 },
		toksState: { state: "hidden" },
		config: configOverrides ? { ...defaultConfig, ...configOverrides } : defaultConfig,
		...rest,
	};
}

describe("tok/s activity display", () => {
	it("shows activity label for tool execution", () => {
		const input = makeInput({ toksState: { state: "activity", label: "edit..." } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("edit...");
	});

	it("shows normalized tool label", () => {
		const input = makeInput({ toksState: { state: "activity", label: "nexus..." } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("nexus...");
	});

	it("activity state does NOT show tok/s suffix", () => {
		const input = makeInput({ toksState: { state: "activity", label: "edit..." } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).not.toContain("tok/s");
	});

	it("pending state shows dots + tok/s", () => {
		const input = makeInput({ toksState: { state: "pending" } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("tok/s");
	});

	it("rate state still works", () => {
		const input = makeInput({
			toksState: { state: "rate", value: 82, approximate: false },
		});
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("82 tok/s");
	});

	it("activity state applies token color", () => {
		const input = makeInput({ toksState: { state: "activity", label: "edit..." } });
		const [line] = renderFooter(input, captureTheme, 200);
		expect(line).toContain("[muted:edit...]");
	});

	it("hidden state shows nothing", () => {
		const input = makeInput({ toksState: { state: "hidden" } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).not.toContain("tok/s");
		expect(line).not.toContain("edit...");
	});
});
