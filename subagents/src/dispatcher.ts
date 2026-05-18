import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { AgentConfig, AgentProgress, AgentResult } from "./types";
import { loadAgents } from "./registry";
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
	extDir: string,
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

	pi.registerCommand("sub-model", {
		description: "Select model for subagents via TUI overlay",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const agents = getAgents();
			if (agents.length === 0) {
				ctx.ui.notify("No agents available.", "warning");
				return;
			}

			const models = ctx.modelRegistry.getAvailable();
			if (models.length === 0) {
				ctx.ui.notify("No models with auth configured.", "warning");
				return;
			}

			const agentNames = agents.map((a) => a.name);
			const modelEntries = models.map((m) => ({
				provider: m.provider,
				id: m.id,
				label: `${m.provider}/${m.id}`,
			}));

			const { loadConfig, saveConfig } = await import("./config");
			const config = loadConfig(extDir);
			const modelMap: Record<string, string> = {};
			for (const [k, v] of Object.entries(config.models || {})) {
				modelMap[k] = typeof v === "string" ? v : (v as any).model;
			}

			let step: "agent" | "model" = "agent";
			let agentCursor = 0;
			let modelCursor = 0;
			let selectedAgent = "";
			let searchQuery = "";

			const filteredModels = () =>
				searchQuery
					? modelEntries.filter((m) =>
							m.label
								.toLowerCase()
								.includes(searchQuery.toLowerCase()),
						)
					: modelEntries;

			const findModelCursor = (label: string) => {
				const idx = filteredModels().findIndex(
					(m) => m.label === label,
				);
				return idx >= 0 ? idx : 0;
			};

			const border = (lines: string[], width: number, theme: any) => {
				const w = Math.min(width - 4, 72);
				const top =
					theme.fg("muted", "┌") +
					theme.fg("muted", "─".repeat(w - 2)) +
					theme.fg("muted", "┐");
				const bottom =
					theme.fg("muted", "└") +
					theme.fg("muted", "─".repeat(w - 2)) +
					theme.fg("muted", "┘");
				const bordered = lines.map((line) => {
					const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
					const pad = Math.max(0, w - 2 - stripped.length);
					return (
						theme.fg("muted", "│") +
						line +
						" ".repeat(pad) +
						theme.fg("muted", "│")
					);
				});
				return [top, ...bordered, bottom];
			};

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					let cachedWidth: number | undefined;
					let cachedLines: string[] | undefined;

					const buildLines = (width: number): string[] => {
						const inner: string[] = [];

						if (step === "agent") {
							inner.push(
								theme.fg(
									"accent",
									theme.bold("  ⚡ Select Agent"),
								),
							);
							inner.push(
								theme.fg(
									"muted",
									"  Choose an agent to change its model",
								),
							);
							inner.push("");

							for (let i = 0; i < agentNames.length; i++) {
								const name = agentNames[i];
								const current =
									modelMap[name] || "(default)";
								const selected = i === agentCursor;
								const prefix = selected
									? theme.fg("accent", "▸ ")
									: "  ";
								const nameStr = selected
									? theme.fg(
											"accent",
											theme.bold(name),
										)
									: theme.fg("text", name);
								const modelStr = theme.fg(
									"muted",
									` │ ${current}`,
								);
								inner.push(
									`  ${prefix}${nameStr}${modelStr}`,
								);
							}
							inner.push("");
							inner.push(
								theme.fg(
									"muted",
									"  [↑↓] navigate │ [enter] select │ [esc] close",
								),
							);
						} else {
							const filtered = filteredModels();
							inner.push(
								theme.fg(
									"accent",
									theme.bold(
										`  ⚡ Model for ${selectedAgent}`,
									),
								),
							);
							inner.push(
								theme.fg(
									"muted",
									`  Current: ${modelMap[selectedAgent] || "(default)"}`,
								),
							);
							inner.push("");
							inner.push(
								`  ${theme.fg("muted", "Search: ")}${theme.fg("accent", searchQuery || "...")}${theme.fg("muted", "█")}`,
							);
							inner.push("");

							const maxVisible = Math.min(
								filtered.length,
								12,
							);
							const startIdx = Math.max(
								0,
								modelCursor - maxVisible + 2,
							);

							for (
								let i = startIdx;
								i <
								Math.min(
									filtered.length,
									startIdx + maxVisible,
								);
								i++
							) {
								const m = filtered[i];
								const selected = i === modelCursor;
								const prefix = selected
									? theme.fg("accent", "▸ ")
									: "  ";
								const label = selected
									? theme.fg(
											"accent",
											theme.bold(m.label),
										)
									: theme.fg("text", m.label);
								const isCurrent =
									m.label ===
									modelMap[selectedAgent];
								const tag = isCurrent
									? theme.fg("success", " ✓")
									: "";
								inner.push(
									`  ${prefix}${label}${tag}`,
								);
							}

							if (filtered.length === 0) {
								inner.push(
									theme.fg(
										"muted",
										"  No models match search",
									),
								);
							}
							if (filtered.length > maxVisible) {
								inner.push(
									theme.fg(
										"muted",
										`  ... ${filtered.length - maxVisible} more`,
									),
								);
							}
							inner.push("");
							inner.push(
								theme.fg(
									"muted",
									"  [↑↓] nav │ [type] search │ [enter] set │ [ctrl+s] save │ [backspace] reset │ [esc] back",
								),
							);
						}

						return border(inner, width, theme);
					};

					return {
						handleInput(data: string) {
							// Ctrl+S: save config and refresh agents
							if (data === "\x13") {
								saveConfig(extDir, config);
								loadAgents(extDir, config);
								// Update modelMap from refreshed config
								for (const [k, v] of Object.entries(
									config.models || {},
								)) {
									modelMap[k] =
										typeof v === "string"
											? v
											: (v as any).model;
								}
								ctx.ui.notify(
									"⚡ Config saved, agents refreshed",
									"info",
								);
								cachedWidth = undefined;
								cachedLines = undefined;
								tui.requestRender();
								return;
							}
							if (matchesKey(data, "escape")) {
								if (step === "model") {
									step = "agent";
									searchQuery = "";
								} else {
									done(undefined);
									return;
								}
							} else if (step === "agent") {
								if (matchesKey(data, "up")) {
									agentCursor =
										(agentCursor -
											1 +
											agentNames.length) %
										agentNames.length;
								} else if (matchesKey(data, "down")) {
									agentCursor =
										(agentCursor + 1) %
										agentNames.length;
								} else if (matchesKey(data, "return")) {
									selectedAgent =
										agentNames[agentCursor];
									searchQuery = "";
									modelCursor = findModelCursor(
										modelMap[selectedAgent] || "",
									);
									step = "model";
								} else {
									return;
								}
							} else {
								if (matchesKey(data, "up")) {
									const fm = filteredModels();
									modelCursor =
										(modelCursor - 1 + fm.length) %
										fm.length;
								} else if (matchesKey(data, "down")) {
									const fm = filteredModels();
									modelCursor =
										(modelCursor + 1) % fm.length;
								} else if (matchesKey(data, "return")) {
									const fm = filteredModels();
									if (fm.length === 0) return;
									const chosen = fm[modelCursor];
									modelMap[selectedAgent] =
										chosen.label;
									if (!config.models)
										config.models = {};
									const existing =
										config.models[selectedAgent];
									if (
										typeof existing === "object" &&
										existing !== null
									) {
										existing.model = chosen.label;
									} else {
										config.models[selectedAgent] =
											chosen.label;
									}
									saveConfig(extDir, config);
									ctx.ui.notify(
										`⚡ ${selectedAgent} → ${chosen.label}`,
										"info",
									);
									searchQuery = "";
									step = "agent";
								} else if (
									matchesKey(data, "backspace") ||
									matchesKey(data, "delete")
								) {
									if (searchQuery.length > 0) {
										searchQuery = searchQuery.slice(
											0,
											-1,
										);
										modelCursor = Math.min(
											modelCursor,
											filteredModels().length - 1,
										);
									} else {
										delete modelMap[selectedAgent];
										if (config.models)
											delete config.models[
												selectedAgent
											];
										saveConfig(extDir, config);
										ctx.ui.notify(
											`⚡ ${selectedAgent} → (default)`,
											"info",
										);
										step = "agent";
									}
								} else if (
									data.length === 1 &&
									data >= " "
								) {
									searchQuery += data;
									modelCursor = 0;
								} else {
									return;
								}
							}

							cachedWidth = undefined;
							cachedLines = undefined;
							tui.requestRender();
						},
						invalidate() {
							cachedWidth = undefined;
							cachedLines = undefined;
						},
						render(width: number): string[] {
							if (cachedLines && cachedWidth === width)
								return cachedLines;
							cachedLines = buildLines(width);
							cachedWidth = width;
							return cachedLines;
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						maxHeight: "80%",
						width: "80%",
					},
				},
			);
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
