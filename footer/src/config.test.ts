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

	it("rejects JSON array as root value", () => {
		const configPath = join(tempDir, "array.json");
		writeFileSync(configPath, JSON.stringify([1, 2, 3]));

		const result = loadConfig([configPath]);
		expect(result.loadedPaths).toEqual([]);
		expect(result.error).toContain("config must be a JSON object");
	});

	it("rejects JSON null as root value", () => {
		const configPath = join(tempDir, "null.json");
		writeFileSync(configPath, "null");

		const result = loadConfig([configPath]);
		expect(result.loadedPaths).toEqual([]);
		expect(result.error).toContain("config must be a JSON object");
	});

	it("rejects JSON string as root value", () => {
		const configPath = join(tempDir, "string.json");
		writeFileSync(configPath, JSON.stringify("just a string"));

		const result = loadConfig([configPath]);
		expect(result.loadedPaths).toEqual([]);
		expect(result.error).toContain("config must be a JSON object");
	});

	it("rejects JSON number as root value", () => {
		const configPath = join(tempDir, "number.json");
		writeFileSync(configPath, JSON.stringify(42));

		const result = loadConfig([configPath]);
		expect(result.loadedPaths).toEqual([]);
		expect(result.error).toContain("config must be a JSON object");
	});
	it("skips non-object file but loads valid files after it", () => {
		const badPath = join(tempDir, "bad.json");
		const goodPath = join(tempDir, "good.json");
		writeFileSync(badPath, JSON.stringify([1, 2, 3]));
		writeFileSync(goodPath, JSON.stringify({ showGit: false }));

		const result = loadConfig([badPath, goodPath]);
		expect(result.loadedPaths).toEqual([goodPath]);
		expect(result.config.showGit).toBe(false);
		expect(result.error).toContain("config must be a JSON object");
	});

	it("loads valid file but reports error for non-object file after it", () => {
		const goodPath = join(tempDir, "good.json");
		const badPath = join(tempDir, "bad.json");
		writeFileSync(goodPath, JSON.stringify({ separator: " | " }));
		writeFileSync(badPath, "null");

		const result = loadConfig([goodPath, badPath]);
		expect(result.loadedPaths).toEqual([goodPath]);
		expect(result.config.separator).toBe(" | ");
		expect(result.error).toContain("config must be a JSON object");
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
		writeFileSync(global, JSON.stringify({ modelAliases: { sonnet: "s4" } }));
		writeFileSync(project, JSON.stringify({ modelAliases: { opus: "o3" } }));

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
