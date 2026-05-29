import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { defaultConfig } from "./configSchema.js";

describe("loadConfig", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns default config for empty paths array", () => {
		const result = loadConfig([]);
		expect(result.config).toEqual(defaultConfig);
		expect(result.loadedPaths).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("handles malformed JSON gracefully", () => {
		const badPath = join(tempDir, "bad.json");
		writeFileSync(badPath, "{invalid json!!!");

		const result = loadConfig([badPath]);
		expect(result.error).toBeDefined();
		expect(result.error).toContain(badPath);
		expect(result.loadedPaths).toEqual([]);
	});

	it("aggregates multiple errors with semicolon separator", () => {
		const badPath1 = join(tempDir, "bad1.json");
		const badPath2 = join(tempDir, "bad2.json");
		writeFileSync(badPath1, "not json");
		writeFileSync(badPath2, "also not json");

		const result = loadConfig([badPath1, badPath2]);
		expect(result.error).toContain(badPath1);
		expect(result.error).toContain(badPath2);
		expect(result.error).toContain(";");
	});

	it("returns loadedPaths for valid configs", () => {
		const goodPath = join(tempDir, "good.json");
		writeFileSync(goodPath, JSON.stringify({ name: "Test" }));

		const result = loadConfig([goodPath]);
		expect(result.loadedPaths).toEqual([goodPath]);
		expect(result.config.name).toBe("Test");
		expect(result.error).toBeUndefined();
	});
});
