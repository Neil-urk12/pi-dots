import { describe, it, expect } from "vitest";
import { renderFooter } from "./renderer.js";
import type { FooterInput, Theme, Totals } from "./types.js";
import { defaultConfig as baseDefaultConfig, resolveConfigWithWarnings, type ResolvedConfig } from "./config.js";

// ── Test helpers ───────────────────────────────────────────────

const plainTheme = {
	fg: (_name: string, text: string) => text,
} as unknown as Theme;

const captureTheme = {
	fg: (name: string, text: string) => `[${name}:${text}]`,
} as unknown as Theme;

const defaultConfig: ResolvedConfig = {
	...baseDefaultConfig,
};

const zeroTotals: Totals = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
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
		config: configOverrides
			? { ...defaultConfig, ...configOverrides }
			: defaultConfig,
		...rest,
	};
}

// ── Basic structure ────────────────────────────────────────────

describe("renderFooter", () => {
	it("returns a single line", () => {
		const result = renderFooter(makeInput(), plainTheme, 100);
		expect(result).toHaveLength(1);
	});

	it("returns a string for every width tier", () => {
		for (const width of [30, 40, 60, 80, 100, 120]) {
			const [line] = renderFooter(makeInput(), plainTheme, width);
			expect(line).toBeTypeOf("string");
			expect(line.length).toBeGreaterThan(0);
		}
	});

	// ── Width-dependent layout ───────────────────────────────

	it("shows model+dir+git on left at width >= 40", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 60);
		expect(line).toContain("sonnet-4");
		expect(line).toContain("my-project");
		expect(line).toContain("main");
	});

	it("shows only model on left at width < 40", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 30);
		expect(line).toContain("sonnet-4");
		expect(line).not.toContain("my-project");
		expect(line).not.toContain("main");
	});

	it("shows context on right at width >= 40", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 40);
		expect(line).toContain("ctx");
	});

	it("shows context on right at width < 40", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 30);
		expect(line).toContain("ctx");
	});

	it("shows full tokens at width >= 100", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("↯"); // cache read indicator = full mode
		expect(line).toContain("↥"); // cache write indicator
	});

	it("shows no-cache tokens at width 80-99", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 80);
		expect(line).toContain("Σ");
		expect(line).not.toContain("↯");
		expect(line).not.toContain("↥");
	});

	it("shows total-only tokens at width 60-79", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 60);
		expect(line).toContain("Σ");
	});

	it("hides tokens at width < 60", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 40);
		expect(line).not.toContain("Σ");
	});

	// ── Config-driven visibility ─────────────────────────────

	it("omits directory when showDirectory is false", () => {
		const input = makeInput({
			configOverrides: { showDirectory: false },
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).not.toContain("my-project");
	});

	it("omits git when showGit is false", () => {
		const input = makeInput({
			configOverrides: { showGit: false },
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).not.toContain("main");
	});

	it("omits context when showContext is false", () => {
		const input = makeInput({
			configOverrides: { showContext: false },
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).not.toContain("ctx");
	});

	it("omits tokens when showTokens is false", () => {
		const input = makeInput({
			configOverrides: { showTokens: false },
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).not.toContain("Σ");
		expect(line).not.toContain("↑");
	});

	it("excludes cache from full tokens when showCache is false", () => {
		const input = makeInput({
			configOverrides: { showCache: false },
		});
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).not.toContain("↯");
		expect(line).not.toContain("↥");
		expect(line).toContain("Σ"); // totals still shown
	});

	// ── Color application ───────────────────────────────────

	it("applies colors to each segment", () => {
		const input = makeInput();
		// Use generous width so color tags don't trigger truncation
		const [line] = renderFooter(input, captureTheme, 200);
		expect(line).toContain("[accent:sonnet-4]");
		expect(line).toContain("[dim:my-project]");
		expect(line).toContain("[success:main]");
		expect(line).toContain("[muted:↑");
	});

	it("applies dirty git color when there are changes", () => {
		const input = makeInput({ gitDirtyCount: 3 });
		const [line] = renderFooter(input, captureTheme, 200);
		expect(line).toContain("[warning:●3]");
	});

	// ── Model formatting ───────────────────────────────────

	it("uses alias when configured", () => {
		const input = makeInput({
			modelId: "anthropic/claude-sonnet-4-20250514",
			configOverrides: {
				modelAliases: {
					"claude-sonnet-4-20250514": "my-sonnet",
				},
			},
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).toContain("[accent:my-sonnet]");
	});

	it("shows effort when showEffort is true and level is set", () => {
		const input = makeInput({ thinkingLevel: "high" });
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).toContain(" • high");
	});

	it("hides effort when showEffort is false", () => {
		const input = makeInput({
			thinkingLevel: "high",
			configOverrides: { showEffort: false },
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).not.toContain(" • high");
	});

	// ── Git formatting ─────────────────────────────────────

	it("shows dirty count when there are changes", () => {
		const input = makeInput({ gitDirtyCount: 5 });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("●5");
	});

	it("omits git dirty badge when clean", () => {
		const input = makeInput({ gitDirtyCount: 0 });
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).not.toContain("●");
	});

	it("omits git segment when branch is undefined", () => {
		const input = makeInput({ gitBranch: undefined });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).not.toContain("main");
	});

	// ── Context thresholds ─────────────────────────────────

	it("renders context in dim when max is unknown", () => {
		const input = makeInput({
			contextMax: undefined,
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).toContain("[dim:ctx");
	});

	it("renders context in warning when near warning threshold", () => {
		const input = makeInput({
			contextUsed: 140_000, // 70%
			contextMax: 200_000,
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).toContain("[warning:ctx");
	});

	it("renders context in error when above danger threshold", () => {
		const input = makeInput({
			contextUsed: 180_000, // 90%
			contextMax: 200_000,
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).toContain("[error:ctx");
	});

	it("renders context in success when far from thresholds", () => {
		const input = makeInput({
			contextUsed: 40_000, // 20%
			contextMax: 200_000,
		});
		const [line] = renderFooter(input, captureTheme, 100);
		expect(line).toContain("[success:ctx");
	});

	// ── Edge cases ─────────────────────────────────────────

	it("handles missing directory gracefully", () => {
		const input = makeInput({ directory: undefined });
		expect(() =>
			renderFooter(input, plainTheme, 100),
		).not.toThrow();
	});

	it("handles zero totals", () => {
		const input = makeInput({ totals: zeroTotals });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("↑0 ↓0 Σ0");
	});

	it("handles empty model id gracefully", () => {
		const input = makeInput({ modelId: "" });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(typeof line).toBe("string");
	});

	it("renders the separator between segments", () => {
		const input = makeInput();
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain(" | ");
	});

	it("uses custom separator between rendered segments", () => {
		const input = makeInput({ configOverrides: { separator: " • " } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain(" • ");
		expect(line).not.toContain(" | ");
	});

	it("uses configured left and right segment order", () => {
		const input = makeInput({
			configOverrides: {
				layouts: [{ minWidth: 0, left: ["git", "model"], right: ["tokensTotal", "context"] }],
			},
		});
		const [line] = renderFooter(input, plainTheme, 200);
		expect(line.indexOf("main")).toBeLessThan(line.indexOf("sonnet-4"));
		expect(line.indexOf("Σ2.0k")).toBeLessThan(line.indexOf("ctx"));
	});

	it("selects highest matching layout when layouts are out of order", () => {
		const config = resolveConfigWithWarnings({
			...defaultConfig,
			layouts: [
				{ minWidth: 0, left: ["model"], right: [] },
				{ minWidth: 100, left: ["git"], right: [] },
				{ minWidth: 60, left: ["directory"], right: [] },
			],
		}).config;
		const input = makeInput({ config });
		const [line] = renderFooter(input, plainTheme, 80);
		expect(line).toContain("my-project");
		expect(line).not.toContain("sonnet-4");
		expect(line).not.toContain("main");
	});

	it("handles NaN in totals gracefully", () => {
		const input = makeInput({ totals: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("↑0 ↓0 Σ0");
		expect(line).toContain("↯0 ↥0");
	});

	it("handles Infinity in totals gracefully", () => {
		const input = makeInput({ totals: { input: Infinity, output: 0, cacheRead: 0, cacheWrite: 0 } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("↑0 ↓0 Σ0");
	});

	it("handles negative values in totals gracefully", () => {
		const input = makeInput({ totals: { input: -500, output: -200, cacheRead: 0, cacheWrite: 0 } });
		const [line] = renderFooter(input, plainTheme, 100);
		expect(line).toContain("↑0 ↓0 Σ0");
	});
});
