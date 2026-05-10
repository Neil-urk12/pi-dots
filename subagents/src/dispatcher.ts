import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfig, AgentProgress, AgentResult } from "./types";
import { formatDuration, formatTokens } from "./format";
import {
	renderSubagentCall,
	renderSubagentResult,
	getTermWidth,
} from "./renderer";
import type { SubagentRunner } from "./runner";
import { mapConcurrent } from "./concurrent";
import { throttle } from "./runner";

export function registerSubagentCommands(
	pi: ExtensionAPI,
	getAgents: () => AgentConfig[],
	runner: SubagentRunner,
	maxConcurrency: number,
) {
	async function runAgentCommand(
		agentName: string,
		task: string,
		ctx: ExtensionContext,
	) {
		if (!ctx.hasUI) return;

		const agents = getAgents();
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
					{
						type: "text",
						text: `/${agentName} ${task}\n\n${result.output}`,
					},
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
			const agents = getAgents();

			if (params.tasks && params.tasks.length > 0) {
				const taskList = params.tasks;
				const available = agents.map((a) => a.name).join(", ") || "none";
				for (const t of taskList) {
					if (!agents.find((a) => a.name === t.agent)) {
						throw new Error(
							`Unknown agent: ${t.agent}. Available agents: ${available}`,
						);
					}
				}

				const allResults: AgentResult[] = [];

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

						allResults[idx] = result;
						flushParallelUpdate();

						return result;
					},
				);

				const outputParts = results.map((r) => {
					const header = `## ${r.agent}${r.exitCode !== 0 ? " (FAILED)" : ""}`;
					return `${header}\n\n${r.output || "(no output)"}`;
				});

				return {
					content: [{ type: "text", text: outputParts.join("\n\n---\n\n") }],
					details: { mode: "parallel" as const, results },
				};
			} else if (params.agent && params.task) {
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

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme) {
			return renderSubagentResult(result, options, theme, getTermWidth() - 4);
		},
	});
}
