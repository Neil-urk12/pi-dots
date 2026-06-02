import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ModelSelectEvent } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./src/config";
import { getAgents, loadAgents } from "./src/registry";
import { createSubagentRunner } from "./src/runner";
import { registerSubagentCommands } from "./src/dispatcher";
import { parseParentModel } from "./src/settings";

export type { AgentConfig } from "./src/types";
export { registerAgent, unregisterAgent } from "./src/registry";

const BUILTIN_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
]);

const EXT_BASE = path.join(
	process.env.HOME || "~",
	".pi",
	"agent",
	"extensions",
);
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	web_search: path.join(EXT_BASE, "web-search", "index.ts"),
	web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
	bash_guard: path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"tools",
		"bash-guard.ts",
	),
};

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}

export default function (pi: ExtensionAPI) {
	const extDir = path.dirname(new URL(import.meta.url).pathname);
	const config = loadConfig(extDir);
	const maxConcurrency = config.maxConcurrency ?? 4;

	// Track parent model so subagents inherit it by default
	let parentModel = parseParentModel();
	try {
		pi.on("model_select", (evt: ModelSelectEvent) => {
			const model = evt?.model;
			if (model?.id && model?.provider) {
				parentModel = `${model.provider}/${model.id}`;
				loadAgents(extDir, config, parentModel);
			}
		});
	} catch (err) {
		console.error("[subagents] Failed to register model_select handler:", err);
	}

	loadAgents(extDir, config, parentModel);

	const runner = createSubagentRunner({
		piBin: resolvePiBinary(),
		builtinTools: BUILTIN_TOOLS,
		customToolExtensions: CUSTOM_TOOL_EXTENSIONS,
	});

	registerSubagentCommands(pi, getAgents, runner, maxConcurrency, extDir);
}
