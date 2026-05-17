import { describe, expect, it } from "vitest";
import { defaultFooterLayouts, resolveConfigWithWarnings } from "./config.js";

describe("footer config layout resolution", () => {
	it("uses default layouts when layouts are omitted", () => {
		const result = resolveConfigWithWarnings({});
		expect(result.config.layouts).toEqual(defaultFooterLayouts);
		expect(result.warnings).toEqual([]);
	});

	it("sorts custom layouts by minWidth descending", () => {
		const result = resolveConfigWithWarnings({
			layouts: [
				{ minWidth: 0, left: ["model"], right: [] },
				{ minWidth: 100, left: ["git"], right: [] },
				{ minWidth: 60, left: ["directory"], right: ["context"] },
			],
		});

		expect(result.config.layouts.map((layout) => layout.minWidth)).toEqual([
			100,
			60,
			0,
		]);
	});

	it("omits unknown and duplicate segments with warnings", () => {
		const result = resolveConfigWithWarnings({
			layouts: [
				{
					minWidth: 0,
					left: ["model", "git", "git", "missing" as never],
					right: ["context", "model"],
				},
			],
		});

		expect(result.config.layouts[0]).toEqual({
			minWidth: 0,
			left: ["model", "git"],
			right: ["context"],
		});
		expect(result.warnings).toContain(
			"layouts[0].left contains duplicate segment 'git'; omitting",
		);
		expect(result.warnings).toContain(
			"layouts[0].left contains unknown segment 'missing'; omitting",
		);
		expect(result.warnings).toContain(
			"layouts[0].right contains duplicate segment 'model'; omitting",
		);
	});

	it("falls back to defaults when no valid layouts remain", () => {
		const result = resolveConfigWithWarnings({
			layouts: [{ minWidth: -1, left: ["model"], right: [] }],
		});

		expect(result.config.layouts).toEqual(defaultFooterLayouts);
		expect(result.warnings).toContain(
			"layouts[0].minWidth must be a non-negative number; skipping",
		);
		expect(result.warnings).toContain(
			"no valid layouts configured; using default layouts",
		);
	});

	it("falls back to defaults when a layout has no visible segments", () => {
		const result = resolveConfigWithWarnings({
			layouts: [{ minWidth: 0, left: [], right: [] }],
		});

		expect(result.config.layouts).toEqual(defaultFooterLayouts);
		expect(result.warnings).toContain(
			"layouts[0] has no visible segments; skipping",
		);
		expect(result.warnings).toContain(
			"no valid layouts configured; using default layouts",
		);
	});

	it("falls back to defaults when layouts is not an array", () => {
		const result = resolveConfigWithWarnings({ layouts: "bad" as never });

		expect(result.config.layouts).toEqual(defaultFooterLayouts);
		expect(result.warnings).toEqual([
			"layouts must be an array; using default layouts",
		]);
	});
});

describe("footer config presets", () => {
	it("applies supported preset values", () => {
		const result = resolveConfigWithWarnings({ preset: "minimal" });

		expect(result.config.preset).toBe("minimal");
		expect(result.config.separator).toBe(" · ");
		expect(result.config.showDirectory).toBe(false);
		expect(result.config.showGit).toBe(false);
		expect(result.config.showTokens).toBe(false);
		expect(result.config.layouts).toEqual([
			{ minWidth: 0, left: ["model"], right: ["context"] },
		]);
		expect(result.warnings).toEqual([]);
	});

	it("lets explicit user config override preset values", () => {
		const result = resolveConfigWithWarnings({
			preset: "minimal",
			showGit: true,
			separator: " / ",
			layouts: [{ minWidth: 0, left: ["model", "git"], right: [] }],
		});

		expect(result.config.preset).toBe("minimal");
		expect(result.config.showGit).toBe(true);
		expect(result.config.separator).toBe(" / ");
		expect(result.config.layouts).toEqual([
			{ minWidth: 0, left: ["model", "git"], right: [] },
		]);
	});

	it("warns for unknown preset and falls back to default behavior", () => {
		const result = resolveConfigWithWarnings({
			preset: "cyberpunk",
			showGit: false,
		});

		expect(result.config.preset).toBe("default");
		expect(result.config.showGit).toBe(false);
		expect(result.config.layouts).toEqual(defaultFooterLayouts);
		expect(result.warnings).toContain(
			"unknown preset 'cyberpunk'; using default preset",
		);
	});

	it("preserves defaults when preset is omitted", () => {
		const result = resolveConfigWithWarnings({});

		expect(result.config.preset).toBe("default");
		expect(result.config.separator).toBe(" | ");
		expect(result.config.showGit).toBe(true);
		expect(result.config.layouts).toEqual(defaultFooterLayouts);
		expect(result.warnings).toEqual([]);
	});
});
