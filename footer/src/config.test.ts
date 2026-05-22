import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, loadFooterConfig } from "./config.js";

describe("loadConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "footer-config-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads a valid config file", () => {
		const configPath = join(tempDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ showGit: false, separator: " / " }));

		const result = loadConfig([configPath]);
		expect(result.config.showGit).toBe(false);
		expect(result.config.separator).toBe(" / ");
		expect(result.loadedPaths).toEqual([configPath]);
		expect(result.error).toBeUndefined();
	});

	it("skips missing files", () => {
		const result = loadConfig([join(tempDir, "nonexistent.json")]);
		expect(result.loadedPaths).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("reports error for malformed JSON", () => {
		const configPath = join(tempDir, "bad.json");
		writeFileSync(configPath, "{invalid json");

		const result = loadConfig([configPath]);
		expect(result.loadedPaths).toEqual([]);
		expect(result.error).toContain(configPath);
	});

	it("merges multiple config files in order", () => {
		const global = join(tempDir, "global.json");
		const project = join(tempDir, "project.json");
		writeFileSync(global, JSON.stringify({ showGit: false, separator: " / " }));
		writeFileSync(project, JSON.stringify({ showGit: true }));

		const result = loadConfig([global, project]);
		expect(result.config.showGit).toBe(true);
		expect(result.config.separator).toBe(" / ");
		expect(result.loadedPaths).toEqual([global, project]);
	});

	it("merges modelAliases from multiple files", () => {
		const global = join(tempDir, "global.json");
		const project = join(tempDir, "project.json");
		writeFileSync(global, JSON.stringify({ modelAliases: { "sonnet": "s4" } }));
		writeFileSync(project, JSON.stringify({ modelAliases: { "opus": "o3" } }));

		const result = loadConfig([global, project]);
		expect(result.config.modelAliases).toEqual({ sonnet: "s4", opus: "o3" });
	});

	it("merges colors from multiple files", () => {
		const global = join(tempDir, "global.json");
		const project = join(tempDir, "project.json");
		writeFileSync(global, JSON.stringify({ colors: { model: "red" } }));
		writeFileSync(project, JSON.stringify({ colors: { git: "green" } }));

		const result = loadConfig([global, project]);
		expect(result.config.colors.model).toBe("red");
		expect(result.config.colors.git).toBe("green");
	});

	it("returns defaults when no files exist", () => {
		const result = loadConfig([]);
		expect(result.config.preset).toBe("default");
		expect(result.config.showGit).toBe(true);
		expect(result.loadedPaths).toEqual([]);
	});
});

describe("loadFooterConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "footer-config-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads global and project configs in order", () => {
		const globalPath = join(tempDir, "global.json");
		const projectPath = join(tempDir, "project.json");
		writeFileSync(globalPath, JSON.stringify({ showGit: false }));
		writeFileSync(projectPath, JSON.stringify({ showGit: true }));

		const result = loadFooterConfig(globalPath, projectPath);
		expect(result.config.showGit).toBe(true);
		expect(result.loadedPaths).toEqual([globalPath, projectPath]);
	});

	it("works when only global exists", () => {
		const globalPath = join(tempDir, "global.json");
		writeFileSync(globalPath, JSON.stringify({ separator: " > " }));

		const result = loadFooterConfig(globalPath, join(tempDir, "missing.json"));
		expect(result.config.separator).toBe(" > ");
		expect(result.loadedPaths).toEqual([globalPath]);
	});

	it("works when neither exists", () => {
		const result = loadFooterConfig(join(tempDir, "a.json"), join(tempDir, "b.json"));
		expect(result.loadedPaths).toEqual([]);
		expect(result.config.preset).toBe("default");
	});
});
