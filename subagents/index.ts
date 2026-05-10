/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with three agents: blitz, seeker, grind.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	ExtensionConfig,
} from "./src/types";
import { formatDuration, formatTokens } from "./src/format";
import {
	renderSubagentCall,
	renderSubagentResult,
	getTermWidth,
} from "./src/renderer";
import { createSubagentRunner, throttle } from "./src/runner";
import { Type } from "typebox";

export type { AgentConfig };


// ── Config ─────────────────────────────────────────────────────────────

const DEFAULT_MODELS: Record<string, string> = {
	blitz: "anthropic/claude-haiku-4-5",
	seeker: "anthropic/claude-sonnet-4-6",
	grind: "anthropic/claude-sonnet-4-6",
};

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const DEFAULT_MAX_CONCURRENCY = 4;

function loadConfig(): ExtensionConfig {
	// Load from extension directory
	try {
		if (fs.existsSync(CONFIG_PATH)) {
			const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
			const config = JSON.parse(raw) as ExtensionConfig;
			return config;
		}
	} catch {}

	// Fallback: check ~/.pi/agent/subagents.json
	const userConfigPath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"subagents.json",
	);
	try {
		if (fs.existsSync(userConfigPath)) {
			const raw = fs.readFileSync(userConfigPath, "utf-8");
			const config = JSON.parse(raw) as ExtensionConfig;
			return config;
		}
	} catch {}

	return {};
}

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"find",
	"ls",
]);

// Custom tools that require loading an extension into the subagent process
const EXT_BASE = path.join(
	process.env.HOME || "~",
	".pi",
	"agent",
	"extensions",
);
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	web_search: path.join(EXT_BASE, "web-search", "index.ts"),
	web_fetch: path.join(EXT_BASE, "web-fetch", "index.ts"),
	bash_guard: path.join(TOOLS_DIR, "bash-guard.ts"),
};

// ── Agent Discovery & Registration ────────────────────────────────────

let agents: AgentConfig[] = [];

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

function loadAgents(config: ExtensionConfig): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const modelDefaults = { ...DEFAULT_MODELS, ...config.models };
	if (!fs.existsSync(AGENTS_DIR)) return agents;
	for (const entry of fs.readdirSync(AGENTS_DIR)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(AGENTS_DIR, entry);
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
	return agents;
}

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	// Resolve the pi entry point from process.argv[1]
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

// ── Parallel Execution with Concurrency Limit ─────────────────────────

async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = Array.from({ length: items.length });
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < items.length) {
			const i = nextIndex++;
			results[i] = await fn(items[i], i);
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => worker(),
	);
	await Promise.all(workers);
	return results;
}

// ── Extension ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	agents = loadAgents(config);

	const runner = createSubagentRunner({
		piBin: resolvePiBinary(),
		builtinTools: BUILTIN_TOOLS,
		customToolExtensions: CUSTOM_TOOL_EXTENSIONS,
	});

	async function runAgentCommand(
		agentName: string,
		task: string,
		ctx: ExtensionContext,
	) {
		if (!ctx.hasUI) return;

		const agent = agents.find((a) => a.name === agentName);
		if (!agent) {
			ctx.ui.notify(`Agent "${agentName}" not found`, "error");
			return;
		}

		const colors = [
			"accent",
			"success",
			"warning",
			"error",
			"toolTitle",
			"muted",
		];
		const color = colors[Math.floor(Math.random() * colors.length)];
		const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		let spinnerIdx = 0;
		let latestProgress: AgentProgress | null = null;
		const startTime = Date.now();

		const renderStatus = () => {
			const progress = latestProgress;
			const frame = spinnerFrames[spinnerIdx++ % spinnerFrames.length];
			const elapsed = formatDuration(
				progress?.durationMs ?? Date.now() - startTime,
			);
			const toolPart = progress?.currentTool
				? `${progress?.toolCount ?? 0} tools · ${progress.currentTool}`
				: `${progress?.toolCount ?? 0} tools`;
			const parts = [`${frame} ${agentName}`, toolPart];
			if (progress && progress.tokens > 0)
				parts.push(`${formatTokens(progress.tokens)} tok`);
			parts.push(elapsed);
			ctx.ui.notify(ctx.ui.theme.fg(color, parts.join(" · ")), "info");
		};

		renderStatus();
		const interval = setInterval(renderStatus, 80);

		let result: AgentResult;
		try {
			result = await runner.run(
				agent,
				task,
				ctx.cwd,
				undefined,
				(progress) => {
					latestProgress = progress;
				},
			);
		} finally {
			clearInterval(interval);
		}

		if (result.exitCode !== 0 || result.progress.error) {
			pi.sendMessage(
				{
					customType: "subagent-error",
					content: [
						{
							type: "text",
							text: `${agentName} failed: ${result.progress.error || `exit code ${result.exitCode}`}`,
						},
					],
					display: true,
				},
				{ triggerTurn: true },
			);
			return;
		}

		pi.sendMessage(
			{
				customType: "subagent-result",
				content: [
					{ type: "text", text: `/${agentName} ${task}\n\n${result.output}` },
				],
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	pi.registerCommand("blitz", {
		description:
			"Fast codebase recon — explore files, find patterns, map architecture",
		handler: async (args, ctx) => {
			await runAgentCommand("blitz", args, ctx);
		},
	});

	pi.registerCommand("seeker", {
		description: "Web research — search the web and synthesize findings",
		handler: async (args, ctx) => {
			await runAgentCommand("seeker", args, ctx);
		},
	});

	pi.registerCommand("grind", {
		description: "Code changes — read, write, and edit files with safe bash",
		handler: async (args, ctx) => {
			await runAgentCommand("grind", args, ctx);
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a subagent to complete a task. Subagents have NO context from the current conversation — include all necessary context in the task description.",
		promptSnippet: "Run subagents for delegated tasks",
		promptGuidelines: [
			"Parallel tool calls are your primary parallelism mechanism — put multiple independent read/fetch/search calls in one function_calls block. Don't use subagents to parallelize simple I/O.",
			"Use subagent to delegate *reasoning and decisions*: codebase exploration (blitz), web research (seeker), or isolated code changes (grind)",
			"For multiple independent subagent tasks, use parallel mode with tasks[] array",
			"Subagents have NO context from the current conversation — include ALL necessary context in the task description",
		],
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({
					description: "Name of the agent to invoke (SINGLE mode)",
				}),
			),
			task: Type.Optional(
				Type.String({ description: "Task description (SINGLE mode)" }),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent to invoke" }),
						task: Type.String({ description: "Task description" }),
						cwd: Type.Optional(
							Type.String({
								description: "Working directory for the agent process",
							}),
						),
					}),
					{ description: "PARALLEL mode: array of {agent, task} objects" },
				),
			),
			cwd: Type.Optional(
				Type.String({
					description: "Working directory for the agent process (single mode)",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;

			// Validate mode
			if (params.tasks && params.tasks.length > 0) {
				// ── Parallel mode ──
				const taskList = params.tasks;

				// Validate all agents
				const available = agents.map((a) => a.name).join(", ") || "none";
				for (const t of taskList) {
					if (!agents.find((a) => a.name === t.agent)) {
						throw new Error(
							`Unknown agent: ${t.agent}. Available agents: ${available}`,
						);
					}
				}

				const allResults: AgentResult[] = [];

				// Initialize all result slots as pending
				for (let i = 0; i < taskList.length; i++) {
					allResults[i] = {
						agent: taskList[i].agent,
						task: taskList[i].task,
						output: "",
						exitCode: -1,
						model: undefined,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: 0,
							turns: 0,
						},
						progress: {
							agent: taskList[i].agent,
							status: "pending" as any,
							task: taskList[i].task,
							recentTools: [],
							toolCount: 0,
							tokens: 0,
							durationMs: 0,
							lastMessage: "",
						},
					};
				}

				const flushParallelUpdate = () => {
					onUpdate?.({
						content: [
							{ type: "text", text: `Running ${taskList.length} tasks...` },
						],
						details: {
							mode: "parallel" as const,
							results: [...allResults],
						},
					});
				};
				const fireParallelUpdate = throttle(flushParallelUpdate, 150);

				const results = await mapConcurrent(
					taskList,
					maxConcurrency,
					async (t, idx) => {
						const agent = agents.find((a) => a.name === t.agent)!;
						const result = await runner.run(
							agent,
							t.task,
							t.cwd ?? cwd,
							signal,
							(progress) => {
								allResults[idx].progress = progress;
								fireParallelUpdate();
							},
						);

						// Update allResults with the completed result so the UI reflects it immediately
						allResults[idx] = result;
						flushParallelUpdate();

						return result;
					},
				);

				// Build final output text
				const outputParts = results.map((r) => {
					const header = `## ${r.agent}${r.exitCode !== 0 ? " (FAILED)" : ""}`;
					return `${header}\n\n${r.output || "(no output)"}`;
				});

				return {
					content: [{ type: "text", text: outputParts.join("\n\n---\n\n") }],
					details: { mode: "parallel" as const, results },
				};
			} else if (params.agent && params.task) {
				// ── Single mode ──
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => a.name).join(", ") || "none";
					throw new Error(
						`Unknown agent: ${params.agent}. Available agents: ${available}`,
					);
				}

				const liveResult: AgentResult = {
					agent: params.agent!,
					task: params.task!,
					output: "",
					exitCode: -1,
					model: agent.model,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						turns: 0,
					},
					progress: {
						agent: params.agent!,
						status: "running" as const,
						task: params.task!,
						recentTools: [],
						toolCount: 0,
						tokens: 0,
						durationMs: 0,
						lastMessage: "",
					},
				};
				const result = await runner.run(
					agent,
					params.task,
					params.cwd ?? cwd,
					signal,
					(progress) => {
						liveResult.progress = progress;
						onUpdate?.({
							content: [{ type: "text", text: "(running...)" }],
							details: { mode: "single" as const, results: [liveResult] },
						});
					},
				);

				const isError = result.exitCode !== 0 || !!result.progress.error;
				return {
					content: [{ type: "text", text: result.output || "(no output)" }],
					details: { mode: "single" as const, results: [result] },
					...(isError ? { isError: true } : {}),
				};
			} else {
				throw new Error(
					"Provide either (agent + task) for single mode, or tasks[] for parallel mode.",
				);
			}
		},

		// ── Render: tool call header ──
		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		// ── Render: result ──
		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme, getTermWidth() - 4);
		},
	});
}
