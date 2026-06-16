import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { Subagent } from "./subagent.ts";
import {
	type AgentRun,
	createInitialRun,
	type TeamMember,
} from "./types.ts";

export const SpawnParams = Type.Object({
	name: Type.String({ description: "Team member name (matches YAML 'name' field)" }),
	task: Type.Optional(
		Type.String({ description: "Override the agent's default task. Falls back to YAML 'task' when omitted." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Wall-clock timeout in milliseconds. If the agent runs longer, it is killed and the run is marked as error with a 'timed out after Xms' message.",
			minimum: 1,
		}),
	),
});

export const KillParams = Type.Object({
	name: Type.String({ description: "Team member name to abort" }),
});

export const StatusParams = Type.Object({
	name: Type.Optional(
		Type.String({ description: "Specific agent to inspect; omit to list every team member" }),
	),
});

export const StepParams = Type.Object({
	name: Type.String({ description: "Team member name (matches YAML 'name' field)" }),
	task: Type.Optional(
		Type.String({
			description:
				"Override the agent's default task. Falls back to YAML 'task' when omitted. Use '{previous}' as a placeholder for the prior step's output.",
		}),
	),
});

export const AggregateParams = Type.Object({
	tasks: Type.Array(StepParams, {
		minItems: 1,
		description: "Parallel tasks to run before the aggregator.",
	}),
	aggregator: Type.Object({
		name: Type.String({ description: "Aggregator team member name (matches YAML 'name' field)." }),
		task: Type.String({
			description:
				"Aggregator task. Use '{previous}' anywhere to receive the joined prior outputs (one block per task).",
		}),
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Per-spawn wall-clock timeout in milliseconds. Applies to all tasks and the aggregator.",
			minimum: 1,
		}),
	),
});

export const ChainParams = Type.Object({
	steps: Type.Array(StepParams, {
		minItems: 1,
		description:
			"Sequential steps. Each step's '{previous}' is replaced with the prior step's output (empty for the first step).",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Per-spawn wall-clock timeout in milliseconds. Applies to all steps.",
			minimum: 1,
		}),
	),
});

export type SpawnArgs = Static<typeof SpawnParams>;
export type KillArgs = Static<typeof KillParams>;
export type StatusArgs = Static<typeof StatusParams>;
export type StepArgs = Static<typeof StepParams>;
export type AggregateArgs = Static<typeof AggregateParams>;
export type ChainArgs = Static<typeof ChainParams>;

type SpawnFn = (
	member: TeamMember,
	task: string,
	signal: AbortSignal | undefined,
	timeoutMs: number | undefined,
) => Promise<AgentRun>;

type StepResult = Readonly<{ name: string; output: string }>;

const formatPriorOutputs = (results: readonly StepResult[]): string =>
	results.map((result) => `=== ${result.name} ===\n${result.output}`).join("\n\n");

export type AggregateResult = Readonly<{
	output: string;
	tasks: readonly StepResult[];
	aggregatorRun: AgentRun;
}>;

/**
 * Run a list of tasks in parallel, then run an aggregator with the joined
 * prior outputs substituted as {previous}. The spawn function is injected so
 * the same logic is testable without a live Subagent.
 */
export const runAggregate = async (
	params: AggregateArgs,
	signal: AbortSignal | undefined,
	getTeam: () => ReadonlyMap<string, TeamMember>,
	spawn: SpawnFn,
): Promise<AggregateResult> => {
	const team = getTeam();
	for (const t of params.tasks) {
		if (!team.has(t.name)) {
			throw new Error(`unknown agent '${t.name}'. available: ${formatAvailableAgents(team)}`);
		}
	}
	if (!team.has(params.aggregator.name)) {
		throw new Error(`unknown agent '${params.aggregator.name}'. available: ${formatAvailableAgents(team)}`);
	}

	const taskResults = await Promise.all(
		params.tasks.map(async (t): Promise<StepResult> => {
			const member = team.get(t.name)!;
			const taskText = (t.task ?? member.task).trim();
			if (taskText.length === 0) {
				throw new Error(`no task supplied for '${t.name}' and YAML 'task' is empty`);
			}
			const run = await spawn(member, taskText, signal, params.timeoutMs);
			if (run.state === "error") {
				throw new Error(`${t.name} failed: ${run.lastError || run.transcript}`);
			}
			return { name: t.name, output: run.transcript || "" };
		}),
	);

	const aggregatorMember = team.get(params.aggregator.name)!;
	const aggregatorTask = params.aggregator.task.replaceAll(
		"{previous}",
		formatPriorOutputs(taskResults),
	);
	const aggregatorRun = await spawn(aggregatorMember, aggregatorTask, signal, params.timeoutMs);
	if (aggregatorRun.state === "error") {
		throw new Error(
			`aggregator '${params.aggregator.name}' failed: ${aggregatorRun.lastError || aggregatorRun.transcript}`,
		);
	}

	return {
		output: aggregatorRun.transcript || "(no output)",
		tasks: taskResults,
		aggregatorRun,
	};
};

export type ChainResult = Readonly<{
	output: string;
	steps: readonly StepResult[];
}>;

/**
 * Run a list of steps sequentially. Each step's task has all occurrences of
 * {previous} replaced with the prior step's output (empty string for step 0).
 */
export const runChain = async (
	params: ChainArgs,
	signal: AbortSignal | undefined,
	getTeam: () => ReadonlyMap<string, TeamMember>,
	spawn: SpawnFn,
): Promise<ChainResult> => {
	const team = getTeam();
	const stepResults: StepResult[] = [];
	let previous = "";

	for (let i = 0; i < params.steps.length; i++) {
		const step = params.steps[i]!;
		if (!team.has(step.name)) {
			throw new Error(
				`step ${i}: unknown agent '${step.name}'. available: ${formatAvailableAgents(team)}`,
			);
		}
		const member = team.get(step.name)!;
		const taskText = (step.task ?? member.task).replaceAll("{previous}", previous);
		const run = await spawn(member, taskText, signal, params.timeoutMs);
		if (run.state === "error") {
			throw new Error(`step ${i} ('${step.name}') failed: ${run.lastError || run.transcript}`);
		}
		const output = run.transcript || "";
		stepResults.push({ name: step.name, output });
		previous = output;
	}

	const last = stepResults[stepResults.length - 1];
	return {
		output: last?.output || "(no output)",
		steps: stepResults,
	};
};

const asTextContent = (text: string) => ({ type: "text" as const, text });

const formatAvailableAgents = (team: ReadonlyMap<string, TeamMember>): string =>
	[...team.keys()].join(", ") || "(no team members loaded)";

const formatDuration = (millis: number): string => {
	if (millis < 1000) return `${millis}ms`;
	const seconds = Math.round(millis / 100) / 10;
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
};

const describeRunDuration = (run: AgentRun): string => {
	if (run.startedAt === 0) return "—";
	return formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
};

const escapeTableCell = (raw: string): string =>
	raw.replace(/\|/g, "\\|").replace(/\n/g, " ").trim() || "—";

const buildTableRow = (cells: readonly string[]): string =>
	`| ${cells.map(escapeTableCell).join(" | ")} |`;

const truncateTaskCell = (task: string): string =>
	task.length <= 60 ? task : `${task.slice(0, 59)}…`;

const renderStatusTable = (
	team: ReadonlyMap<string, TeamMember>,
	runs: readonly AgentRun[],
): string => {
	const runsByName = new Map(runs.map((run) => [run.name, run]));
	const teamRows = Array.from(team.values(), (member) => {
		const run = runsByName.get(member.name);
		return buildTableRow([
			member.name,
			member.role,
			run?.state ?? "idle",
			run ? describeRunDuration(run) : "—",
			truncateTaskCell(run?.task || member.task),
		]);
	});
	const orphanRows = runs
		.filter((run) => !team.has(run.name))
		.map((run) => buildTableRow([run.name, "?", run.state, describeRunDuration(run), truncateTaskCell(run.task)]));
	return [
		buildTableRow(["name", "role", "state", "duration", "task"]),
		"|---|---|---|---|---|",
		...teamRows,
		...orphanRows,
	].join("\n");
};

const renderSingleAgentStatus = (run: AgentRun, member: TeamMember | undefined): string => {
	const lines = [
		`name: ${run.name}`,
		`role: ${member?.role ?? "?"}`,
		`state: ${run.state}`,
		`model: ${member?.model ?? "?"}`,
		`duration: ${describeRunDuration(run)}`,
		`task: ${run.task || member?.task || ""}`,
	];
	if (run.lastError) lines.push(`error: ${run.lastError}`);
	if (run.transcript) lines.push("", "transcript:", run.transcript);
	return lines.join("\n");
};

type StatusDetails = Readonly<{
	team: readonly TeamMember[];
	runs: readonly AgentRun[];
	focused?: { run: AgentRun; member: TeamMember | undefined };
}>;

export const registerTools = (
	pi: ExtensionAPI,
	subagent: Subagent,
	getTeam: () => ReadonlyMap<string, TeamMember>,
): void => {
	const spawn: SpawnFn = (member, task, signal, timeoutMs) =>
		subagent.spawn(member, task, signal, timeoutMs);

	pi.registerTool({
		name: "nano_agent_spawn",
		label: "Spawn nano-team agent",
		description:
			"Run a pre-defined team member as an isolated pi subagent. The agent's YAML 'task' is the default; pass `task` to override per call. Multiple agents can run in parallel via parallel tool calls.",
		promptSnippet:
			"`nano_agent_spawn(name, task?, timeoutMs?)` — delegate a subtask to a pre-defined nano-team member.",
		parameters: SpawnParams,
		async execute(_toolCallId, params: SpawnArgs, signal) {
			const team = getTeam();
			const member = team.get(params.name);
			if (!member) {
				throw new Error(`unknown agent '${params.name}'. available: ${formatAvailableAgents(team)}`);
			}
			const task = (params.task ?? member.task).trim();
			if (!task) {
				throw new Error(`no task supplied for '${params.name}' and YAML 'task' is empty`);
			}
			const run = await subagent.spawn(member, task, signal, params.timeoutMs);
			if (run.state === "error") {
				throw new Error(run.lastError || run.transcript || `agent '${params.name}' failed`);
			}
			return { content: [asTextContent(run.transcript || "(no output)")], details: { run } };
		},
	});

	pi.registerTool({
		name: "nano_agent_kill",
		label: "Kill nano-team agent",
		description: "Abort a currently running team member. Use the agent's name (matches YAML 'name' field).",
		promptSnippet: "`nano_agent_kill(name)` — abort a stuck or no-longer-needed nano-team agent.",
		parameters: KillParams,
		async execute(_toolCallId, params: KillArgs) {
			if (!subagent.kill(params.name)) {
				throw new Error(`agent '${params.name}' is not running`);
			}
			return { content: [asTextContent(`killed '${params.name}'`)], details: { name: params.name } };
		},
	});

	pi.registerTool<typeof StatusParams, StatusDetails>({
		name: "nano_agent_status",
		label: "Status of nano-team agents",
		description:
			"Inspect team members. With `name`, returns details for that agent (state, transcript, error). Without, returns a markdown table of all agents.",
		promptSnippet:
			"`nano_agent_status(name?)` — list nano-team agents and their states (or one agent's transcript).",
		parameters: StatusParams,
		async execute(_toolCallId, params: StatusArgs) {
			const team = getTeam();
			const teamArray = [...team.values()];
			const allRuns = subagent.list();
			if (params.name) {
				const member = team.get(params.name);
				const existingRun = subagent.get(params.name);
				if (!member && !existingRun) {
					throw new Error(`unknown agent '${params.name}'. available: ${formatAvailableAgents(team)}`);
				}
				const focusedRun = existingRun ?? createInitialRun(params.name, member?.task ?? "");
				return {
					content: [asTextContent(renderSingleAgentStatus(focusedRun, member))],
					details: { team: teamArray, runs: allRuns, focused: { run: focusedRun, member } },
				};
			}
			if (team.size === 0 && allRuns.length === 0) {
				return {
					content: [asTextContent("no team members defined. add YAML files under .pi/nano-team/team/")],
					details: { team: teamArray, runs: allRuns },
				};
			}
			return {
				content: [asTextContent(renderStatusTable(team, allRuns))],
				details: { team: teamArray, runs: allRuns },
			};
		},
	});

	pi.registerTool({
		name: "nano_agent_aggregate",
		label: "Aggregate nano-team agents",
		description:
			"Run multiple subagents in parallel, then run an aggregator with the joined prior outputs substituted as {previous}. Composes nano_agent_spawn.",
		promptSnippet:
			"`nano_agent_aggregate(tasks, aggregator, timeoutMs?)` — run N agents in parallel, then aggregate.",
		parameters: AggregateParams,
		async execute(_toolCallId, params: AggregateArgs, signal) {
			const result = await runAggregate(params, signal, getTeam, spawn);
			return {
				content: [asTextContent(result.output)],
				details: { tasks: result.tasks, aggregator: result.aggregatorRun },
			};
		},
	});

	pi.registerTool({
		name: "nano_agent_chain",
		label: "Chain nano-team agents",
		description:
			"Run subagents sequentially. Each step's {previous} is replaced with the prior step's output. The final step's output is returned.",
		promptSnippet:
			"`nano_agent_chain(steps, timeoutMs?)` — run agents sequentially, chaining outputs via {previous}.",
		parameters: ChainParams,
		async execute(_toolCallId, params: ChainArgs, signal) {
			const result = await runChain(params, signal, getTeam, spawn);
			return {
				content: [asTextContent(result.output)],
				details: { steps: result.steps },
			};
		},
	});
};
