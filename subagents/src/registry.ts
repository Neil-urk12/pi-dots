import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, ExtensionConfig } from "./types";

export const DEFAULT_MODELS: Record<string, string> = {
	blitz: "anthropic/claude-haiku-4-5",
	seeker: "anthropic/claude-sonnet-4-6",
	grind: "anthropic/claude-sonnet-4-6",
};

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function validateThinking(value: string | undefined): AgentConfig["thinking"] | undefined {
	if (value === undefined) return undefined;
	return VALID_THINKING_LEVELS.has(value) ? (value as AgentConfig["thinking"]) : undefined;
}

let agents: AgentConfig[] = [];
let dynamicAgentNames = new Set<string>();

export function getAgents(): AgentConfig[] {
	return agents;
}

export function registerAgent(config: AgentConfig): void {
	if (agents.find((a) => a.name === config.name)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	dynamicAgentNames.add(config.name);
	agents.push(config);
}

export function unregisterAgent(name: string): void {
	agents = agents.filter((a) => a.name !== name);
	dynamicAgentNames.delete(name);
}

/** Reset all agents and dynamic tracking. For test use only. */
export function resetAgents(): void {
	agents = [];
	dynamicAgentNames.clear();
}

// Expose registration functions globally so other extensions loaded via jiti
// (which creates separate module instances) can access the shared agents array.
(globalThis as any).__pi_subagents = { registerAgent, unregisterAgent, getAgents };

export function loadAgents(extDir: string, config: ExtensionConfig, parentModel?: string): void {
	// Preserve dynamically registered agents across reloads
	const preserved = agents.filter(a => dynamicAgentNames.has(a.name));
	agents = [];
	const modelDefaults: Record<string, string> = {
		...DEFAULT_MODELS,
		...Object.fromEntries(
			Object.entries(config.models || {}).map(([k, v]) => [
				k,
				typeof v === "string" ? v : v.model,
			]),
		),
	};
	const agentsDir = path.join(extDir, "agents");
	if (!fs.existsSync(agentsDir)) {
		agents.push(...preserved);
		return;
	}

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
		const extensions = frontmatter.extensions
			? frontmatter.extensions.split(",").map(e => e.trim()).filter(Boolean)
			: [];
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools,
			model:
				frontmatter.model ||
				modelDefaults[frontmatter.name] ||
				parentModel ||
				"anthropic/claude-sonnet-4-6",
			thinking: validateThinking(
				frontmatter.thinking ??
				(typeof (config.models as any)[frontmatter.name] === "object"
					? (config.models as any)[frontmatter.name].thinking
					: undefined)
			),
			systemPrompt: body,
			filePath,
			useParentExtensions: frontmatter.useParentExtensions === "true",
			extensions: extensions.length > 0 ? extensions : undefined,
		});
	}
	agents.push(...preserved);
}
