import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";

vi.mock("node:fs");
vi.mock("node:os");

const mockFs = vi.mocked(fs);
const mockOs = vi.mocked(os);
const { parseParentModel } = await import("./settings");

describe("parseParentModel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns provider/model when settings has both fields", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readFileSync as any).mockReturnValue(
			JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6" }),
		);
		expect(parseParentModel("/fake/dir")).toBe("anthropic/claude-sonnet-4-6");
	});

	it("returns undefined when settings.json does not exist", () => {
		mockFs.existsSync.mockReturnValue(false);
		expect(parseParentModel("/fake/dir")).toBeUndefined();
	});

	it("returns undefined when defaultProvider is missing", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readFileSync as any).mockReturnValue(
			JSON.stringify({ defaultModel: "claude-sonnet-4-6" }),
		);
		expect(parseParentModel("/fake/dir")).toBeUndefined();
	});

	it("returns undefined when defaultModel is missing", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readFileSync as any).mockReturnValue(
			JSON.stringify({ defaultProvider: "anthropic" }),
		);
		expect(parseParentModel("/fake/dir")).toBeUndefined();
	});

	it("returns undefined and logs warning on malformed JSON", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readFileSync as any).mockReturnValue("not valid json{");
		expect(parseParentModel("/fake/dir")).toBeUndefined();
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("settings.json"),
			expect.any(String),
		);
	});

	it("uses settingsDir parameter for path resolution", () => {
		mockFs.existsSync.mockReturnValue(false);
		parseParentModel("/custom/path");
		expect(mockFs.existsSync).toHaveBeenCalledWith("/custom/path/settings.json");
	});

	it("returns undefined when both fields are empty strings", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readFileSync as any).mockReturnValue(
			JSON.stringify({ defaultProvider: "", defaultModel: "" }),
		);
		expect(parseParentModel("/fake/dir")).toBeUndefined();
	});

	it("uses os.homedir() when HOME env var is unset", () => {
		const origHome = process.env.HOME;
		try {
			delete process.env.HOME;
			mockOs.homedir.mockReturnValue("/mock/home");
			mockFs.existsSync.mockReturnValue(false);
			parseParentModel();
			expect(mockFs.existsSync).toHaveBeenCalledWith("/mock/home/.pi/agent/settings.json");
		} finally {
			if (origHome !== undefined) process.env.HOME = origHome;
			else delete process.env.HOME;
		}
	});

	it("returns undefined when both fields are whitespace-only strings", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readFileSync as any).mockReturnValue(
			JSON.stringify({ defaultProvider: " ", defaultModel: " " }),
		);
		expect(parseParentModel("/fake/dir")).toBeUndefined();
	});

	it("trims whitespace from provider and model", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readFileSync as any).mockReturnValue(
			JSON.stringify({ defaultProvider: " anthropic ", defaultModel: " claude-sonnet-4-6 " }),
		);
		expect(parseParentModel("/fake/dir")).toBe("anthropic/claude-sonnet-4-6");
	});
});