import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { Subagent } from "./subagent.ts";
import { type AgentRun, type TeamMember } from "./types.ts";
import { getErrorMessage } from "./errors.ts";

export const SpawnParams = Type.Object({
	name: Type.String({ description: "Team member name (matches YAML 'name' field)" }),
	task: Type.Optional(
		Type.String({ description: "Override the agent's default task. Falls back to YAML 'task' when omitted." }),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Wall-clock timeout in milliseconds. If the agent runs longer, it is killed and the run is marked as error with a 'timed out after Xms' message. Defaults to 300000 (5 minutes) if omitted.",
			minimum: 1,
		}),
	),
});

/**
 * Default per-spawn wall-clock timeout. Empirical observation across
 * parallel-spawn benchmarks: real model calls land in 20-60s but
 * rate-limited calls can block 2-3 minutes before the API replies.
 * 5 minutes (300_000ms) gives 5-10x headroom over typical calls and
 * absorbs a single rate-limit retry window. Override per-call with
 * `timeoutMs`. For long-running batches, pass a higher value explicitly.
 */
export const DEFAULT_SPAWN_TIMEOUT_MS = 300_000;

export const KillParams = Type.Object({
	name: Type.String({ description: "Team member name to abort" }),
	instanceId: Type.Optional(
		Type.String({
			description:
				"Optional `instanceId` returned from the original `nano_agent_spawn` call. Required when the name has more than one live run; the call rejects as ambiguous otherwise.",
		}),
	),
});

export const StatusParams = Type.Object({
	name: Type.Optional(
		Type.String({ description: "Specific agent to inspect; omit to list every team member" }),
	),
	instanceId: Type.Optional(
		Type.String({
			description:
				"Optional `instanceId` (returned from the original spawn) to inspect a single run. Required when `name` has more than one live run; rejected as ambiguous otherwise.",
		}),
	),
});

export const StepParams = Type.Object({
	name: Type.String({ description: "Team member name (matches YAML 'name' field)" }),
	task: Type.Optional(
		Type.String({
			description:
				"Override the agent's default task. Falls back to YAML 'task' when omitted. Use '{previous}' as a placeholder for the prior step's output. Write '{{previous}}' (doubled braces) to embed the literal token without substitution.",
		}),
	),
	instance: Type.Optional(
		Type.String({
			description:
				"Optional label for this instance, used to disambiguate runs of the same agent within a batch. The Subagent mints a `${name}-${n}` `instanceId` at spawn time; supplying `instance` lets you reference a specific run when calling `nano_agent_kill` or `nano_agent_status` afterward. Must be unique across `tasks[]` when provided.",
		}),
	),
});

export const AggregateParams = Type.Object({
	tasks: Type.Array(StepParams, {
		minItems: 1,
		description:
			"Parallel tasks to run before the aggregator. Names must be unique unless the agent has `readOnly: true`. `instance` labels must be unique across the batch when provided.",
	}),
	aggregator: Type.Object({
		name: Type.String({ description: "Aggregator team member name (matches YAML 'name' field)." }),
		task: Type.String({
			description:
				"Aggregator task. Use '{previous}' anywhere to receive the joined prior outputs (one block per task). Write '{{previous}}' (doubled braces) to embed the literal token without substitution.",
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
			"Sequential steps. Each step's '{previous}' is replaced with the prior step's output (empty for the first step). Write '{{previous}}' (doubled braces) to embed the literal token without substitution.",
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

type StepResult = Readonly<{ name: string; instanceId: string; output: string }>;

/**
 * Substitutes `{previous}` with the prior step's output. Doubled braces
 * (`{{previous}}`) escape the placeholder and resolve to the literal
 * token `{previous}`, so users can discuss the syntax in their prompts
 * without it being clobbered. Order of operations matters: escape first,
 * substitute, then restore the literal.
 */
const PREVIOUS_PLACEHOLDER = "{previous}";
const PREVIOUS_ESCAPE = "{{previous}}";
const PREVIOUS_SENTINEL = "\u0000PREVIOUS_LITERAL\u0000";

const substitutePrevious = (template: string, previous: string): string =>
	template
		.replaceAll(PREVIOUS_ESCAPE, PREVIOUS_SENTINEL)
		.replaceAll(PREVIOUS_PLACEHOLDER, previous)
		.replaceAll(PREVIOUS_SENTINEL, PREVIOUS_PLACEHOLDER);

const formatPriorOutputs = (results: readonly StepResult[]): string =>
	results.map((result) => `=== ${result.name} (${result.instanceId}) ===\n${result.output}`).join("\n\n");

/**
 * Failure descriptor for a partial aggregate result.
 * - `task` — one of the parallel tasks failed (with its index, name, and reason).
 * - `aggregator` — all parallel tasks completed but the aggregator itself failed.
 */
export type AggregateFailure =
	| { readonly kind: "task"; readonly index: number; readonly name: string; readonly reason: string }
	| { readonly kind: "aggregator"; readonly name: string; readonly reason: string };

/**
 * Result of `runAggregate`.
 * - `done` — all parallel tasks completed AND the aggregator completed.
 * - `partial` — at least one parallel task or the aggregator failed;
 *   `tasks` contains whatever completed, `failure` describes what stopped the run.
 *
 * Configuration errors (unknown agent, empty task, duplicate name on a
 * write-capable agent, duplicate instance label) still throw — only
 * execution-time failures produce a partial result.
 */
export type AggregateResult =
	| {
			readonly kind: "done";
			readonly output: string;
			readonly tasks: readonly StepResult[];
			readonly aggregatorRun: AgentRun;
	  }
	| {
			readonly kind: "partial";
			readonly tasks: readonly StepResult[];
			readonly failure: AggregateFailure;
	  };

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

	// Pre-validation: caller errors throw loudly. We check all tasks up front
	// (not lazily) so the LLM sees every problem at once, not one round-trip
	// at a time. Duplicate `instance` labels are caught here so two same-named
	// tasks in the same batch can't silently collide on the same id.
	const seenNames = new Set<string>();
	const seenInstances = new Set<string>();
	for (let i = 0; i < params.tasks.length; i++) {
		const t = params.tasks[i]!;
		const member = team.get(t.name);
		if (!member) {
			throw new Error(
				`task ${i}: unknown agent '${t.name}'. available: ${formatAvailableAgents(team)}`,
			);
		}
		// Same name is allowed only when the agent is read-only (multiple
		// concurrent instances are the point). Write-capable agents still
		// enforce single-slot semantics across the batch.
		if (seenNames.has(t.name) && member.readOnly !== true) {
			throw new Error(
				`task ${i}: duplicate name '${t.name}' in tasks[] (agent is not read-only)`,
			);
		}
		if (t.instance !== undefined) {
			if (seenInstances.has(t.instance)) {
				throw new Error(`task ${i}: duplicate instance '${t.instance}' in tasks[]`);
			}
			seenInstances.add(t.instance);
		}
		seenNames.add(t.name);
		const taskText = (t.task ?? member.task).trim();
		if (taskText.length === 0) {
			throw new Error(`no task supplied for '${t.name}' and YAML 'task' is empty`);
		}
	}
	if (!team.has(params.aggregator.name)) {
		throw new Error(
			`unknown agent '${params.aggregator.name}'. available: ${formatAvailableAgents(team)}`,
		);
	}
	const aggregatorMember = team.get(params.aggregator.name)!;
	const aggregatorTemplate = params.aggregator.task.trim();
	if (aggregatorTemplate.length === 0) {
		throw new Error(
			`no task supplied for '${params.aggregator.name}' and YAML 'task' is empty`,
		);
	}

	// Run all parallel tasks. Promise.allSettled keeps the in-flight
	// subprocesses running after a throw, so we can recover their outputs
	// into the partial result.
	const settled = await Promise.allSettled(
		params.tasks.map(
			async (t): Promise<StepResult> => {
				const member = team.get(t.name)!;
				const taskText = (t.task ?? member.task).trim();
				const run = await spawn(member, taskText, signal, params.timeoutMs);
				if (run.state === "error") {
					throw new Error(`${t.name} (${run.instanceId}) failed: ${run.lastError || run.transcript}`);
				}
				return { name: t.name, instanceId: run.instanceId, output: run.transcript || "" };
			},
		),
	);

	const tasks: StepResult[] = [];
	let firstFailure: { index: number; name: string; reason: string } | null = null;
	for (let i = 0; i < settled.length; i++) {
		const r = settled[i]!;
		if (r.status === "fulfilled") {
			tasks.push(r.value);
		} else if (firstFailure === null) {
			firstFailure = {
				index: i,
				name: params.tasks[i]!.name,
				reason: getErrorMessage(r.reason),
			};
		}
	}

	if (firstFailure !== null) {
		return {
			kind: "partial",
			tasks,
			failure: { kind: "task", ...firstFailure },
		};
	}

	// All parallel tasks completed. Substitute {previous} in the aggregator task
	// and run it. A post-substitution empty task is a partial result (the user
	// gets the completed tasks back, with a clear reason for the stop).
	const aggregatorTask = substitutePrevious(aggregatorTemplate, formatPriorOutputs(tasks)).trim();
	if (aggregatorTask.length === 0) {
		return {
			kind: "partial",
			tasks,
			failure: {
				kind: "aggregator",
				name: params.aggregator.name,
				reason: "aggregator task resolved to empty/whitespace after {previous} substitution",
			},
		};
	}

	const aggregatorRun = await spawn(aggregatorMember, aggregatorTask, signal, params.timeoutMs);
	if (aggregatorRun.state === "error") {
		return {
			kind: "partial",
			tasks,
			failure: {
				kind: "aggregator",
				name: params.aggregator.name,
				reason: `${params.aggregator.name} failed: ${aggregatorRun.lastError || aggregatorRun.transcript}`,
			},
		};
	}

	return {
		kind: "done",
		output: aggregatorRun.transcript || "(no output)",
		tasks,
		aggregatorRun,
	};
};

/**
 * Result of `runChain`.
 * - `done` — every step completed; `output` is the last step's transcript.
 * - `partial` — a step failed mid-chain; `steps` contains whatever completed,
 *   `failure` points at the failing step.
 *
 * Configuration errors (unknown agent, empty task) still throw.
 */
export type ChainFailure = {
	readonly index: number;
	readonly name: string;
	readonly reason: string;
};

export type ChainResult =
	| {
			readonly kind: "done";
			readonly output: string;
			readonly steps: readonly StepResult[];
	  }
	| {
			readonly kind: "partial";
			readonly steps: readonly StepResult[];
			readonly failure: ChainFailure;
	  };

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
	const steps: StepResult[] = [];
	let previous = "";

	for (let i = 0; i < params.steps.length; i++) {
		const step = params.steps[i]!;
		if (!team.has(step.name)) {
			throw new Error(
				`step ${i}: unknown agent '${step.name}'. available: ${formatAvailableAgents(team)}`,
			);
		}
		const member = team.get(step.name)!;
		const taskText = substitutePrevious(step.task ?? member.task, previous).trim();
		if (taskText.length === 0) {
			throw new Error(`no task supplied for '${step.name}' and YAML 'task' is empty`);
		}
		const run = await spawn(member, taskText, signal, params.timeoutMs);
		if (run.state === "error") {
			return {
				kind: "partial",
				steps,
				failure: {
					index: i,
					name: step.name,
					reason: `${step.name} (${run.instanceId}) failed: ${run.lastError || run.transcript}`,
				},
			};
		}
		const output = run.transcript || "";
		steps.push({ name: step.name, instanceId: run.instanceId, output });
		previous = output;
	}

	const last = steps[steps.length - 1];
	return {
		kind: "done",
		output: last?.output || "(no output)",
		steps,
	};
};

const asTextContent = (text: string) => ({ type: "text" as const, text });

/**
 * Cap the "available:" tail in unknown-agent errors so a 100-member roster
 * doesn't bloat LLM context on every typo. The first 10 names are shown
 * verbatim; the remainder are summarized. The LLM can call
 * `nano_agent_status` to see the full list.
 */
const MAX_AVAILABLE_AGENTS_IN_ERROR = 10;

const formatAvailableAgents = (team: ReadonlyMap<string, TeamMember>): string => {
	const names = [...team.keys()];
	if (names.length === 0) return "(no team members loaded)";
	if (names.length <= MAX_AVAILABLE_AGENTS_IN_ERROR) return names.join(", ");
	return `${names.slice(0, MAX_AVAILABLE_AGENTS_IN_ERROR).join(", ")}, ... and ${names.length - MAX_AVAILABLE_AGENTS_IN_ERROR} more`;
};

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

/**
 * Format a list of runs grouped by name. With the instance model, a name
 * may have multiple live instances plus completed instances; this renders
 * one row per `instanceId`, grouped under their agent name. Live runs
 * appear before terminal-state runs within each group.
 */
const renderStatusTable = (
	team: ReadonlyMap<string, TeamMember>,
	runs: readonly AgentRun[],
): string => {
	const runsByName = new Map<string, AgentRun[]>();
	for (const run of runs) {
		const list = runsByName.get(run.name);
		if (list === undefined) runsByName.set(run.name, [run]);
		else list.push(run);
	}
	const teamRows: string[] = [];
	for (const member of team.values()) {
		const memberRuns = runsByName.get(member.name) ?? [];
		if (memberRuns.length === 0) {
			teamRows.push(buildTableRow([member.name, member.role, "idle", "—", truncateTaskCell(member.task)]));
			continue;
		}
		for (const run of memberRuns) {
			teamRows.push(
				buildTableRow([
					`${member.name} (${run.instanceId})`,
					member.role,
					run.state,
					describeRunDuration(run),
					truncateTaskCell(run.task || member.task),
				]),
			);
		}
	}
	for (const run of runs) {
		if (team.has(run.name)) continue;
		teamRows.push(buildTableRow([`${run.name} (${run.instanceId})`, "?", run.state, describeRunDuration(run), truncateTaskCell(run.task)]));
	}
	return [buildTableRow(["name (instance)", "role", "state", "duration", "task"]), "|---|---|---|---|---|", ...teamRows].join(
		"\n",
	);
};

const renderSingleAgentStatus = (run: AgentRun, member: TeamMember | undefined): string => {
	const lines = [
		`name: ${run.name}`,
		`instance: ${run.instanceId}`,
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

/**
 * Format a partial aggregate result for the LLM. Includes the completed
 * tasks' outputs (same format as `{previous}` substitution) so the LLM
 * can pick up where the run stopped.
 */
const formatAggregatePartial = (
	result: Extract<AggregateResult, { kind: "partial" }>,
	total: number,
): string => {
	const completed = result.tasks.length;
	const failureLine =
		result.failure.kind === "task"
			? `task ${result.failure.index} ('${result.failure.name}') failed: ${result.failure.reason}`
			: `aggregator ('${result.failure.name}') failed: ${result.failure.reason}`;
	return [
		`Partial aggregate: ${completed} of ${total} task${total === 1 ? "" : "s"} completed before failure.`,
		"",
		completed > 0 ? "Completed tasks:" : "(no tasks completed)",
		completed > 0 ? formatPriorOutputs(result.tasks) : "",
		"",
		`Failure: ${failureLine}`,
	]
		.filter((line) => line !== "")
		.join("\n");
};

/**
 * Format a partial chain result for the LLM. Includes the completed
 * steps' outputs (same format as `{previous}` substitution) so the LLM
 * can pick up where the chain stopped.
 */
const formatChainPartial = (result: Extract<ChainResult, { kind: "partial" }>, total: number): string => {
	const completed = result.steps.length;
	return [
		`Partial chain: ${completed} of ${total} step${total === 1 ? "" : "s"} completed before failure.`,
		"",
		completed > 0 ? "Completed steps:" : "(no steps completed)",
		completed > 0 ? formatPriorOutputs(result.steps) : "",
		"",
		`Failure: step ${result.failure.index} ('${result.failure.name}') failed: ${result.failure.reason}`,
	]
		.filter((line) => line !== "")
		.join("\n");
};

type StatusDetails = Readonly<{
	team: readonly TeamMember[];
	runs: readonly AgentRun[];
	focused?: { run: AgentRun; member: TeamMember | undefined };
}>;

/**
 * Resolve a (name, optional instanceId) pair against the live runs of
 * that name. Returns:
 *  - `{ kind: "none" }` when no live run exists for the name;
 *  - `{ kind: "one", instanceId }` when exactly one live run exists;
 *  - `{ kind: "many", instanceIds }` when 2+ live runs exist (the caller
 *    must require `instanceId` or reject as ambiguous).
 *
 * If `instanceId` is provided and matches one of the live runs, the
 * result short-circuits to `{ kind: "one", instanceId }`.
 */
type Disambiguation =
	| { readonly kind: "none" }
	| { readonly kind: "one"; readonly instanceId: string }
	| { readonly kind: "many"; readonly instanceIds: readonly string[] };

const resolveDisambiguation = (
	subagent: Subagent,
	name: string,
	instanceId: string | undefined,
): Disambiguation => {
	const live = subagent.getLiveByName(name);
	if (instanceId !== undefined) {
		const match = live.find((run) => run.instanceId === instanceId);
		if (match === undefined) {
			// Caller asked for a specific instance that isn't live. Treat
			// the same as `none` so the kill/status tool surfaces a clean
			// "not running" error.
			return { kind: "none" };
		}
		return { kind: "one", instanceId: match.instanceId };
	}
	if (live.length === 0) return { kind: "none" };
	if (live.length === 1) {
		const single = live[0]!;
		return { kind: "one", instanceId: single.instanceId };
	}
	return { kind: "many", instanceIds: live.map((run) => run.instanceId) };
};

type AggregateDetails =
	| { readonly kind: "done"; readonly tasks: readonly StepResult[]; readonly aggregatorRun: AgentRun }
	| { readonly kind: "partial"; readonly tasks: readonly StepResult[]; readonly failure: AggregateFailure };

type ChainDetails =
	| { readonly kind: "done"; readonly steps: readonly StepResult[] }
	| { readonly kind: "partial"; readonly steps: readonly StepResult[]; readonly failure: ChainFailure };

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
			"Run a pre-defined team member as an isolated pi subagent. The agent's YAML 'task' is the default; pass `task` to override per call. Multiple agents can run in parallel via parallel tool calls. The returned `instanceId` is needed to disambiguate when an agent has multiple live runs (only possible for read-only agents).",
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
			const timeoutMs = params.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
			const run = await subagent.spawn(member, task, signal, timeoutMs);
			if (run.state === "error") {
				throw new Error(run.lastError || run.transcript || `agent '${params.name}' failed`);
			}
			return { content: [asTextContent(run.transcript || "(no output)")], details: { run } };
		},
	});

	pi.registerTool({
		name: "nano_agent_kill",
		label: "Kill nano-team agent",
		description:
			"Abort a currently running team member. Use the agent's name (matches YAML 'name' field). When the name has more than one live run (only possible for read-only agents), pass `instanceId` (returned from the original `nano_agent_spawn` call); the call rejects as ambiguous otherwise.",
		promptSnippet:
			"`nano_agent_kill(name, instanceId?)` — abort a stuck or no-longer-needed nano-team agent.",
		parameters: KillParams,
		async execute(_toolCallId, params: KillArgs) {
			const disambiguation = resolveDisambiguation(subagent, params.name, params.instanceId);
			if (disambiguation.kind === "none") {
				throw new Error(`agent '${params.name}' is not running`);
			}
			if (disambiguation.kind === "many") {
				throw new Error(
					`agent '${params.name}' has ${disambiguation.instanceIds.length} live instances (${disambiguation.instanceIds.join(", ")}); pass instanceId to disambiguate`,
				);
			}
			if (!subagent.kill(disambiguation.instanceId)) {
				throw new Error(`agent '${params.name}' (${disambiguation.instanceId}) is not running`);
			}
			return {
				content: [asTextContent(`killed '${params.name}' (${disambiguation.instanceId})`)],
				details: { name: params.name, instanceId: disambiguation.instanceId },
			};
		},
	});

	pi.registerTool<typeof StatusParams, StatusDetails>({
		name: "nano_agent_status",
		label: "Status of nano-team agents",
		description:
			"Inspect team members. With `name`, returns details for that agent's current run (state, transcript, error). Without, returns a markdown table of all agents and their live/completed instances. When `name` has multiple live instances (read-only agents), pass `instanceId` to inspect a single run; the call rejects as ambiguous otherwise.",
		promptSnippet:
			"`nano_agent_status(name?, instanceId?)` — list nano-team agents and their states (or one agent's transcript).",
		parameters: StatusParams,
		async execute(_toolCallId, params: StatusArgs) {
			const team = getTeam();
			const teamArray = [...team.values()];
			const allRuns = subagent.list();
			if (params.name) {
				const member = team.get(params.name);
				if (params.instanceId !== undefined) {
					const run = subagent.get(params.instanceId);
					if (!run || run.name !== params.name) {
						throw new Error(
							`no run with instanceId '${params.instanceId}' for agent '${params.name}'`,
						);
					}
					return {
						content: [asTextContent(renderSingleAgentStatus(run, member))],
						details: { team: teamArray, runs: allRuns, focused: { run, member } },
					};
				}
				const disambiguation = resolveDisambiguation(subagent, params.name, undefined);
				if (disambiguation.kind === "many") {
					throw new Error(
						`agent '${params.name}' has ${disambiguation.instanceIds.length} live instances (${disambiguation.instanceIds.join(", ")}); pass instanceId to disambiguate`,
					);
				}
				if (disambiguation.kind === "none") {
					if (!member) {
						throw new Error(`unknown agent '${params.name}'. available: ${formatAvailableAgents(team)}`);
					}
					const focusedRun = subagent.getByName(params.name).at(-1);
					if (focusedRun === undefined) {
						return {
							content: [asTextContent(`agent '${params.name}' has never been spawned`)],
							details: { team: teamArray, runs: allRuns },
						};
					}
					return {
						content: [asTextContent(renderSingleAgentStatus(focusedRun, member))],
						details: { team: teamArray, runs: allRuns, focused: { run: focusedRun, member } },
					};
				}
				const run = subagent.get(disambiguation.instanceId);
				if (!run) {
					// Race: the disambiguation saw it live, but it's gone now.
					throw new Error(`agent '${params.name}' is not running`);
				}
				return {
					content: [asTextContent(renderSingleAgentStatus(run, member))],
					details: { team: teamArray, runs: allRuns, focused: { run, member } },
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

	pi.registerTool<typeof AggregateParams, AggregateDetails>({
		name: "nano_agent_aggregate",
		label: "Aggregate nano-team agents",
		description:
			"Run multiple subagents in parallel, then run an aggregator with the joined prior outputs substituted as {previous}. If any task or the aggregator fails, the result is partial: completed tasks are returned alongside a failure description. Composes nano_agent_spawn. Tasks may reuse the same agent name when that agent has `readOnly: true` (multiple concurrent instances); pass a unique `instance` label per task to target a specific run later via `nano_agent_kill` or `nano_agent_status`.",
		promptSnippet:
			"`nano_agent_aggregate(tasks, aggregator, timeoutMs?)` — run N agents in parallel, then aggregate.",
		parameters: AggregateParams,
		async execute(_toolCallId, params: AggregateArgs, signal): Promise<{ content: { type: "text"; text: string }[]; details: AggregateDetails }> {
			const result = await runAggregate(params, signal, getTeam, spawn);
			if (result.kind === "done") {
				return {
					content: [asTextContent(result.output)],
					details: { kind: "done", tasks: result.tasks, aggregatorRun: result.aggregatorRun },
				};
			}
			return {
				content: [asTextContent(formatAggregatePartial(result, params.tasks.length))],
				details: { kind: "partial", tasks: result.tasks, failure: result.failure },
			};
		},
	});

	pi.registerTool<typeof ChainParams, ChainDetails>({
		name: "nano_agent_chain",
		label: "Chain nano-team agents",
		description:
			"Run subagents sequentially. Each step's {previous} is replaced with the prior step's output. The final step's output is returned. If a step fails, the result is partial: completed steps are returned alongside a failure description.",
		promptSnippet:
			"`nano_agent_chain(steps, timeoutMs?)` — run agents sequentially, chaining outputs via {previous}.",
		parameters: ChainParams,
		async execute(_toolCallId, params: ChainArgs, signal): Promise<{ content: { type: "text"; text: string }[]; details: ChainDetails }> {
			const result = await runChain(params, signal, getTeam, spawn);
			if (result.kind === "done") {
				return {
					content: [asTextContent(result.output)],
					details: { kind: "done", steps: result.steps },
				};
			}
			return {
				content: [asTextContent(formatChainPartial(result, params.steps.length))],
				details: { kind: "partial", steps: result.steps, failure: result.failure },
			};
		},
	});
};
