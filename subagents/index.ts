/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with three agents: blitz, seeker, grind.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	parseFrontmatter,
	truncateHead,
	withFileMutationQueue,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@mariozechner/pi-coding-agent";
import type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	ExtensionConfig,
} from "./src/types";
import {
	formatDuration,
	formatTokens,
	extractToolArgsPreview,
} from "./src/format";
import {
	renderSubagentCall,
	renderSubagentResult,
	getTermWidth,
} from "./src/renderer";
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

// ── Subagent Execution ────────────────────────────────────────────────

async function buildPiArgs(
	agent: AgentConfig,
	task: string,
	_cwd: string,
): Promise<{ args: string[]; tempDir: string }> {
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	// Write system prompt to temp file
	const promptPath = path.join(tempDir, `${agent.name}.md`);
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, agent.systemPrompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});

	const args = [
		...piBin.baseArgs,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
	];

	// Separate builtin tools from custom tools
	const builtinTools: string[] = [];
	const extensionPaths = new Set<string>();

	for (const tool of agent.tools) {
		if (BUILTIN_TOOLS.has(tool)) {
			builtinTools.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	if (!agent.useParentExtensions) {
		args.push("--no-extensions");
	}

	if (builtinTools.length > 0) {
		args.push("--tools", builtinTools.join(","));
	} else {
		// No builtin tools needed — disable defaults so only extension tools are available
		args.push("--no-tools");
	}

	for (const extPath of extensionPaths) {
		args.push("--extension", extPath);
	}

	args.push("--model", agent.model);
	args.push("--append-system-prompt", promptPath);

	// Handle long tasks by writing to file
	const TASK_LIMIT = 8000;
	if (task.length > TASK_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		await withFileMutationQueue(taskPath, async () => {
			await fs.promises.writeFile(taskPath, `Task: ${task}`, {
				encoding: "utf-8",
				mode: 0o600,
			});
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	return { args: [piBin.command, ...args], tempDir };
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

async function runSubagent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (progress: AgentProgress) => void,
): Promise<AgentResult> {
	const { args, tempDir } = await buildPiArgs(agent, task, cwd);
	const command = args[0];
	const spawnArgs = args.slice(1);

	const result: AgentResult = {
		agent: agent.name,
		task,
		output: "",
		exitCode: 0,
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
			agent: agent.name,
			status: "running",
			task,
			recentTools: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastMessage: "",
		},
	};

	const startTime = Date.now();
	const progress = result.progress;

	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		onUpdate?.(progress);
	}, 150);

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(command, spawnArgs, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buf = "";
		let stderrBuf = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const evt = JSON.parse(line) as any;
				progress.durationMs = Date.now() - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview(
						(evt.args || {}) as Record<string, unknown>,
					);
					fireUpdate();
				}

				if (evt.type === "tool_execution_end") {
					if (progress.currentTool) {
						progress.recentTools.push({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
						});
						// Keep last 20
						if (progress.recentTools.length > 20) {
							progress.recentTools.splice(0, progress.recentTools.length - 20);
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					fireUpdate();
				}

				if (evt.type === "tool_result_end") {
					fireUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = result.usage.input + result.usage.output;
						}
						if (evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage)
							progress.error = evt.message.errorMessage;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							result.output = text;
							// Extract just the prose "thinking" text — skip code blocks
							const proseLines: string[] = [];
							let inCodeBlock = false;
							for (const line of text.split("\n")) {
								if (line.trimStart().startsWith("```")) {
									inCodeBlock = !inCodeBlock;
									continue;
								}
								if (!inCodeBlock && line.trim()) {
									proseLines.push(line.trim());
								}
							}
							if (proseLines.length > 0) {
								progress.lastMessage = proseLines.slice(0, 3).join(" ");
							}
						}
					}

					fireUpdate();
				}
			} catch {
				// Non-JSON lines are expected
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});

		proc.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});

		proc.on("close", (code) => {
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !progress.error) {
				progress.error = stderrBuf.trim();
			}
			resolve(code ?? 1);
		});

		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	// Cleanup temp dir
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {}

	result.exitCode = exitCode;
	progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (progress.error)
		result.output = result.output || `Error: ${progress.error}`;

	// Truncate output if very large
	if (result.output.length > DEFAULT_MAX_BYTES) {
		const trunc = truncateHead(result.output, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		result.output = trunc.content;
		if (trunc.truncated) {
			result.output += "\n\n[Output truncated]";
		}
	}

	return result;
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: any[]) => {
		const now = Date.now();
		const remaining = ms - (now - lastCall);
		if (remaining <= 0) {
			lastCall = now;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			fn(...args);
		} else if (!timer) {
			timer = setTimeout(() => {
				lastCall = Date.now();
				timer = undefined;
				fn(...args);
			}, remaining);
		}
	}) as T;
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
			result = await runSubagent(
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
						const result = await runSubagent(
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
				const result = await runSubagent(
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
