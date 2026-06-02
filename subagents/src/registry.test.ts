import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Mock fs and parseFrontmatter before importing
vi.mock("node:fs");
vi.mock("@mariozechner/pi-coding-agent", () => ({
	parseFrontmatter: vi.fn(),
}));

const mockFs = vi.mocked(fs);
const { parseFrontmatter } = await import("@mariozechner/pi-coding-agent");
const mockParseFrontmatter = vi.mocked(parseFrontmatter);

// Import after mocks
const registryModule = await import("./registry");
	const { loadAgents, getAgents, registerAgent, unregisterAgent, resetAgents, validateThinking } = registryModule;

describe("loadAgents", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetAgents();
	});

	it("uses parentModel as fallback when no frontmatter or default model exists", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["test-agent.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: test-agent\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "test-agent", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: {} }, "anthropic/claude-sonnet-4-6");

		const agents = getAgents();
		expect(agents).toHaveLength(1);
		expect(agents[0].model).toBe("anthropic/claude-sonnet-4-6");
	});

	it("frontmatter model takes precedence over parentModel", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["test-agent.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: test-agent\nmodel: openai/gpt-4o\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "test-agent", model: "openai/gpt-4o" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: {} }, "anthropic/claude-sonnet-4-6");

		const agents = getAgents();
		expect(agents[0].model).toBe("openai/gpt-4o");
	});

	it("config model defaults take precedence over parentModel", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["test-agent.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: test-agent\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "test-agent", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: { "test-agent": "google/gemini-2.5-pro" } }, "anthropic/claude-sonnet-4-6");

		const agents = getAgents();
		expect(agents[0].model).toBe("google/gemini-2.5-pro");
	});

	it("model is undefined when no source provides one", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["blitz.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: blitz\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "blitz", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: {} });

		const agents = getAgents();
		expect(agents[0].model).toBeUndefined();
	});

	it("inherits parentModel when provided", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["custom.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: custom\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "custom", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: {} }, "anthropic/claude-sonnet-4-6");

		const agents = getAgents();
		expect(agents[0].model).toBe("anthropic/claude-sonnet-4-6");
	});

	it("preserves dynamically registered agents across loadAgents calls", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["builtin.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: builtin\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "builtin", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: {} });
		expect(getAgents()).toHaveLength(1);

		registerAgent({
			name: "dynamic-agent",
			description: "registered by another extension",
			tools: [],
			model: "openai/gpt-4o",
			systemPrompt: "Dynamic",
			filePath: "/dynamic",
		});
		expect(getAgents()).toHaveLength(2);

		(mockFs.readdirSync as any).mockReturnValue(["builtin.md"]);
		loadAgents("/fake/ext", { models: {} }, "anthropic/claude-sonnet-4-6");

		const agents = getAgents();
		expect(agents).toHaveLength(2);
		expect(agents.find(a => a.name === "dynamic-agent")).toBeDefined();
	});

	it("does not preserve unregistered dynamic agents across reload", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["builtin.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: builtin\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "builtin", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: {} });

		registerAgent({
			name: "temp-agent",
			description: "temporary",
			tools: [],
			model: "openai/gpt-4o",
			systemPrompt: "Temp",
			filePath: "/temp",
		});
		expect(getAgents()).toHaveLength(2);

		unregisterAgent("temp-agent");
		expect(getAgents()).toHaveLength(1);

		// Reload — temp-agent should NOT come back
		loadAgents("/fake/ext", { models: {} }, "anthropic/claude-sonnet-4-6");
		expect(getAgents()).toHaveLength(1);
		expect(getAgents().find(a => a.name === "temp-agent")).toBeUndefined();
	});
});

describe("globalThis bridge", () => {
	it("does not expose resetAgents on globalThis", () => {
		const bridge = (globalThis as any).__pi_subagents;
		expect(bridge).toBeDefined();
		expect(bridge.resetAgents).toBeUndefined();
	});

	it("exposes registerAgent, unregisterAgent, getAgents on globalThis", () => {
		const bridge = (globalThis as Record<string, unknown>).__pi_subagents as Record<string, unknown>;
		expect(typeof bridge.registerAgent).toBe("function");
		expect(typeof bridge.unregisterAgent).toBe("function");
		expect(typeof bridge.getAgents).toBe("function");
	});
});

describe("validateThinking", () => {
	it("accepts valid thinking levels", () => {
		expect(validateThinking("off")).toBe("off");
		expect(validateThinking("minimal")).toBe("minimal");
		expect(validateThinking("low")).toBe("low");
		expect(validateThinking("medium")).toBe("medium");
		expect(validateThinking("high")).toBe("high");
		expect(validateThinking("xhigh")).toBe("xhigh");
	});

	it("returns undefined for undefined input", () => {
		expect(validateThinking(undefined)).toBeUndefined();
	});

	it("returns undefined for invalid thinking values", () => {
		expect(validateThinking("turbo")).toBeUndefined();
		expect(validateThinking("")).toBeUndefined();
		expect(validateThinking("HIGH")).toBeUndefined();
	});

	it("loadAgents ignores invalid thinking from config", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["test-agent.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: test-agent\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "test-agent", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: { "test-agent": { model: "openai/gpt-4o", thinking: "invalid" } } });

		const agents = getAgents();
		expect(agents[0].thinking).toBeUndefined();
	});

	it("loadAgents accepts valid thinking from config", () => {
		mockFs.existsSync.mockReturnValue(true);
		(mockFs.readdirSync as any).mockReturnValue(["test-agent.md"]);
		(mockFs.readFileSync as any).mockReturnValue("---\nname: test-agent\ndescription: test\n---\nSystem prompt");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "test-agent", description: "test" },
			body: "System prompt",
		});

		loadAgents("/fake/ext", { models: { "test-agent": { model: "openai/gpt-4o", thinking: "high" } } });

		const agents = getAgents();
		expect(agents[0].thinking).toBe("high");
	});
});
