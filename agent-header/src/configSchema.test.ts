import { describe, it, expect } from "vitest";
import { resolveConfigWithWarnings, mergeConfig, defaultConfig } from "./configSchema.js";

describe("configSchema", () => {
	describe("resolveConfigWithWarnings", () => {
		it("returns default config when empty", () => {
			const result = resolveConfigWithWarnings({});
			expect(result.config).toEqual(defaultConfig);
			expect(result.warnings).toEqual([]);
		});

		it("preserves custom name", () => {
			const result = resolveConfigWithWarnings({ name: "Custom" });
			expect(result.config.name).toBe("Custom");
		});

		it("falls back to default name for empty string", () => {
			const result = resolveConfigWithWarnings({ name: "" });
			expect(result.config.name).toBe("Sci-pi");
		});

		it("merges partial colors", () => {
			const result = resolveConfigWithWarnings({ colors: { title: "success" } });
			expect(result.config.colors.title).toBe("success");
			expect(result.config.colors.subtitle).toBe("muted");
			expect(result.config.colors.separator).toBe("dim");
		});

		it("respects showGit override", () => {
			const result = resolveConfigWithWarnings({ showGit: false });
			expect(result.config.showGit).toBe(false);
		});
	});

	describe("mergeConfig", () => {
	it("merges base and override", () => {
			const base = { enabled: true, showGit: true };
			const override = { showGit: false, showModel: false };
		const merged = mergeConfig(base, override);
		expect(merged.enabled).toBe(true);
		expect(merged.showGit).toBe(false);
		expect(merged.showModel).toBe(false);
		});

		it("merges nested colors", () => {
			const base = { colors: { title: "accent" } };
			const override = { colors: { subtitle: "success" } };
			const merged = mergeConfig(base, override);
			expect(merged.colors).toEqual({ title: "accent", subtitle: "success" });
		});
	});
});
