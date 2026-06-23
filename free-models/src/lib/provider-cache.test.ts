import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import type { ProviderModelConfig } from "./types.ts";

// Mock node:fs before imports
const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
vi.mock("node:fs", () => ({
	readFileSync: mockReadFileSync,
	existsSync: mockExistsSync,
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger to prevent file I/O
vi.mock("./logger.ts", () => ({
	createLogger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}),
}));

// Must import after mocks
const { loadProviderCache, saveProviderCache, isProviderCacheFresh, DEFAULT_CACHE_TTL_MS } =
	await import("./provider-cache.ts");

const CACHE_DIR = join(process.env.HOME || "", ".pi", "cache");

describe("loadProviderCache", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns null when file does not exist", () => {
		mockExistsSync.mockReturnValue(false);
		expect(loadProviderCache("kilo")).toBeNull();
	});

	it("returns null when file is corrupt JSON", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("not valid json {{{");
		expect(loadProviderCache("kilo")).toBeNull();
	});

	it("returns null when cache entry has empty models", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ models: [], fetchedAt: Date.now(), version: 1 }),
		);
		expect(loadProviderCache("kilo")).toBeNull();
	});

	it("returns models when cache is valid", () => {
		const models: ProviderModelConfig[] = [
			{
				id: "test-model",
				name: "Test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 2048,
			},
		];
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify({ models, fetchedAt: Date.now(), version: 1 }));
		expect(loadProviderCache("kilo")).toEqual(models);
	});
});

describe("saveProviderCache", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("writes models to cache file with correct structure", async () => {
		const { writeFile } = await import("node:fs/promises");
		const models: ProviderModelConfig[] = [
			{
				id: "m1",
				name: "Model 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 2048,
			},
		];

		await saveProviderCache("kilo", models);

		expect(writeFile).toHaveBeenCalledTimes(1);
		const [path, content] = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(path).toBe(join(CACHE_DIR, "kilo-models.json"));

		const entry = JSON.parse(content);
		expect(entry.models).toEqual(models);
		expect(entry.version).toBe(1);
		expect(typeof entry.fetchedAt).toBe("number");
		expect(entry.fetchedAt).toBeGreaterThan(0);
	});
});

describe("isProviderCacheFresh", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns true when cache is within TTL", () => {
		const now = Date.now();
		vi.setSystemTime(now);

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({ models: [{ id: "m1" }], fetchedAt: now, version: 1 }),
		);

		expect(isProviderCacheFresh("kilo", DEFAULT_CACHE_TTL_MS)).toBe(true);
	});

	it("returns false when cache is stale", () => {
		const now = Date.now();
		vi.setSystemTime(now);

		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				models: [{ id: "m1" }],
				fetchedAt: now - DEFAULT_CACHE_TTL_MS - 1,
				version: 1,
			}),
		);

		expect(isProviderCacheFresh("kilo", DEFAULT_CACHE_TTL_MS)).toBe(false);
	});

	it("returns false when no cache file exists", () => {
		mockExistsSync.mockReturnValue(false);
		expect(isProviderCacheFresh("kilo", DEFAULT_CACHE_TTL_MS)).toBe(false);
	});

	it("returns false when cache is corrupt", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue("bad json");
		expect(isProviderCacheFresh("kilo", DEFAULT_CACHE_TTL_MS)).toBe(false);
	});

	it("returns false when fetchedAt is missing", () => {
		mockExistsSync.mockReturnValue(true);
		mockReadFileSync.mockReturnValue(JSON.stringify({ models: [{ id: "m1" }], version: 1 }));
		expect(isProviderCacheFresh("kilo", DEFAULT_CACHE_TTL_MS)).toBe(false);
	});
});
