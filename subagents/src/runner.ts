import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	withFileMutationQueue,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import type { AgentConfig, AgentProgress, AgentResult } from "./types";
import { extractToolArgsPreview } from "./format";
import { resolveProviderExtension } from "./provider-resolver";
import { escapeRegExp, extractTextFromContent } from "./utils";

export interface RunnerOptions {
	piBin: { command: string; baseArgs: string[] };
	builtinTools: Set<string>;
	customToolExtensions: Record<string, string>;
	taskLimit?: number;
}

export interface SubagentRunner {
	run(
		agent: AgentConfig,
		task: string,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (progress: AgentProgress) => void,
	): Promise<AgentResult>;
}

export function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
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

export function createSubagentRunner(options: RunnerOptions): SubagentRunner {
	const TASK_LIMIT = options.taskLimit ?? 8000;

	async function buildPiArgs(
		agent: AgentConfig,
		task: string,
		_cwd: string,
	): Promise<{ args: string[]; tempDir: string; providerExt: string | undefined }> {
		const piBin = options.piBin;
		const tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "pi-sub-"),
		);

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

		const builtinTools: string[] = [];
		const extensionPaths = new Set<string>();
		let providerExt: string | undefined;

		for (const tool of agent.tools) {
			if (options.builtinTools.has(tool)) {
				builtinTools.push(tool);
			} else if (options.customToolExtensions[tool]) {
				extensionPaths.add(options.customToolExtensions[tool]);
			}
		}

		if (agent.extensions) {
			for (const ext of agent.extensions) {
				extensionPaths.add(ext);
			}
		}

		if (!agent.useParentExtensions) {
			args.push("--no-extensions");
			// Auto-include extension that provides the agent's model provider
			if (agent.model) {
				const resolved = await resolveProviderExtension(
					agent.model,
					options.piBin.command,
					options.piBin.baseArgs,
				);
				if (resolved) {
					providerExt = resolved;
					extensionPaths.add(resolved);
				}
			}
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

		if (agent.model) args.push("--model", agent.model);

		if (agent.thinking) {
			args.push("--thinking", agent.thinking);
		}
		args.push("--append-system-prompt", promptPath);

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

		return { args: [piBin.command, ...args], tempDir, providerExt };
	}

	/**
	 * Wait for a model to become available in pi's model registry.
	 * Polls `pi --list-models` until the model appears or timeout.
	 */
	async function waitForModel(
		model: string,
		providerExt: string,
		timeoutMs = 15000,
	): Promise<void> {
		const { command, baseArgs } = options.piBin;
		const deadline = Date.now() + timeoutMs;
		const pollInterval = 1000;

		const slashIdx = model.indexOf("/");
		const pattern = slashIdx > 0
			? escapeRegExp(model.slice(0, slashIdx)) + "\\s+" + escapeRegExp(model.slice(slashIdx + 1))
			: escapeRegExp(model);
		const modelRegex = new RegExp(pattern);

		const args = [...baseArgs, "--no-extensions", "--extension", providerExt, "--list-models"];
		while (Date.now() < deadline) {
			try {
				const output = execFileSync(command, args, { encoding: "utf-8", timeout: 5000 });
				if (modelRegex.test(output)) return;
			} catch {
				// pi list failed — retry
			}
			await new Promise((r) => setTimeout(r, pollInterval));
		}
	}


	async function run(
		agent: AgentConfig,
		task: string,
		cwd: string,
		signal?: AbortSignal,
		onUpdate?: (progress: AgentProgress) => void,
	): Promise<AgentResult> {
		const { args, tempDir, providerExt } = await buildPiArgs(agent, task, cwd);

		// Wait for model to be available if extension-provided (cold-start mitigation)
		if (providerExt && agent.model) {
			await waitForModel(agent.model, providerExt);
		}

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
				env: { ...process.env, PI_IS_SUBAGENT: "1" },
			});

			let buf = "";
			let stderrBuf = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					const evt = JSON.parse(line) as any;
					progress.durationMs = Date.now() - startTime;

					switch (evt.type) {
						case "tool_execution_start": {
							progress.toolCount++;
							progress.currentTool = evt.toolName;
							progress.currentToolArgs = extractToolArgsPreview(
								(evt.args || {}) as Record<string, unknown>,
							);
							fireUpdate();
							break;
						}

						case "tool_execution_end": {
							if (progress.currentTool) {
								progress.recentTools.push({
									tool: progress.currentTool,
									args: progress.currentToolArgs || "",
								});
								if (progress.recentTools.length > 20) {
									progress.recentTools.splice(
										0,
										progress.recentTools.length - 20,
									);
								}
							}
							progress.currentTool = undefined;
							progress.currentToolArgs = undefined;
							fireUpdate();
							break;
						}

						case "tool_result_end":
							fireUpdate();
							break;

						case "message_end": {
							if (evt.message) {
								if (evt.message.role === "assistant") {
									result.usage.turns++;
									const u = evt.message.usage;
									if (u) {
										result.usage.input += u.input || 0;
										result.usage.output += u.output || 0;
										result.usage.cacheRead += u.cacheRead || 0;
										result.usage.cacheWrite += u.cacheWrite || 0;
										result.usage.cost += u.cost?.total || 0;
										progress.tokens =
											result.usage.input + result.usage.output;
									}
									if (evt.message.model) result.model = evt.message.model;
									if (evt.message.errorMessage)
										progress.error = evt.message.errorMessage;

									const text = extractTextFromContent(evt.message.content);
									if (text) {
										result.output = text;
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
											progress.lastMessage = proseLines
												.slice(0, 3)
												.join(" ");
										}
									}
								}
								fireUpdate();
							}
							break;
						}
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
					setTimeout(
						() => !proc.killed && proc.kill("SIGKILL"),
						3000,
					);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});

		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}

		result.exitCode = exitCode;
		progress.status =
			exitCode === 0 && !progress.error ? "completed" : "failed";
		progress.durationMs = Date.now() - startTime;
		if (progress.error)
			result.output = result.output || `Error: ${progress.error}`;

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

	return { run };
}
