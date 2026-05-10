import { spawn } from "node:child_process";
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
	): Promise<{ args: string[]; tempDir: string }> {
		const piBin = options.piBin;
		const tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), "pi-sub-"),
		);

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
			if (options.builtinTools.has(tool)) {
				builtinTools.push(tool);
			} else if (options.customToolExtensions[tool]) {
				extensionPaths.add(options.customToolExtensions[tool]);
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

	async function run(
		agent: AgentConfig,
		task: string,
		cwd: string,
		signal?: AbortSignal,
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
								progress.recentTools.splice(
									0,
									progress.recentTools.length - 20,
								);
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
								progress.tokens =
									result.usage.input + result.usage.output;
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
									progress.lastMessage = proseLines
										.slice(0, 3)
										.join(" ");
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
					setTimeout(
						() => !proc.killed && proc.kill("SIGKILL"),
						3000,
					);
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
		progress.status =
			exitCode === 0 && !progress.error ? "completed" : "failed";
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

	return { run };
}
