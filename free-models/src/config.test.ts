/**
 * Tests for config resolve logic.
 * Validates env var / config file fallback behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "./config.ts";

describe("resolve", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns env var when set to non-empty string", () => {
		process.env["TEST_KEY"] = "my-value";
		expect(resolve("TEST_KEY", "file-val")).toBe("my-value");
	});

	it("returns fileVal when env var is undefined", () => {
		delete process.env["TEST_KEY"];
		expect(resolve("TEST_KEY", "file-val")).toBe("file-val");
	});

	it("returns undefined when both env and fileVal are empty", () => {
		process.env["TEST_KEY"] = "";
		expect(resolve("TEST_KEY", "")).toBeUndefined();
	});

	it("returns fileVal when env var is empty string (not 'unset')", () => {
		// KEY BEHAVIOR: empty string env var should fall through to file value.
		// With ?? this returns "" (bug). With || this falls through (correct).
		process.env["TEST_KEY"] = "";
		expect(resolve("TEST_KEY", "fallback-value")).toBe("fallback-value");
	});

	it("returns undefined when env is empty and fileVal is whitespace-only", () => {
		process.env["TEST_KEY"] = "";
		expect(resolve("TEST_KEY", "   ")).toBeUndefined();
	});

	it("returns undefined when env is undefined and fileVal is undefined", () => {
		delete process.env["TEST_KEY"];
		expect(resolve("TEST_KEY", undefined)).toBeUndefined();
	});

	it("trims fileVal before checking", () => {
		delete process.env["TEST_KEY"];
		expect(resolve("TEST_KEY", "  trimmed  ")).toBe("  trimmed  ");
		// Note: resolve() does NOT trim the returned value, only checks if trimmed is truthy
	});
});
