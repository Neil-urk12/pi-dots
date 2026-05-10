import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, ExtensionConfig } from "./types";

export const DEFAULT_MODELS: Record<string, string> = {
	blitz: "anthropic/claude-haiku-4-5",
	seeker: "anthropic/claude-sonnet-4-6",
	grind: "anthropic/claude-sonnet-4-6",
};

let agents: AgentConfig[] = [];

export function getAgents(): AgentConfig[] {
	return agents;
}

export function registerAgent(config: AgentConfig): void {
	if (agents.find((a) => a.name === config.name)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	agents.push(config);
}

export function unregisterAgent(name: string): void {
	agents = agents.filter((a) => a.name !== name);
}

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent };

export function loadAgents(extDir: string, config: ExtensionConfig): void {
	agents = [];
	const modelDefaults = { ...DEFAULT_MODELS, ...config.models };
	const agentsDir = path.join(extDir, "agents");
	if (!fs.existsSync(agentsDir)) return;

	for (const entry of fs.readdirSync(agentsDir)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(agentsDir, entry);
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } =
			parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name) continue;
		const tools = (frontmatter.tools || "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools,
			model:
				frontmatter.model ||
				modelDefaults[frontmatter.name] ||
				"anthropic/claude-sonnet-4-6",
			systemPrompt: body,
			filePath,
			useParentExtensions: frontmatter.useParentExtensions === "true",
		});
	}
}
