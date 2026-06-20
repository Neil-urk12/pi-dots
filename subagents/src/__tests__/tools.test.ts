import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	runAggregate,
	runChain,
	registerTools,
	type AggregateArgs,
	type ChainArgs,
} from "../tools.ts";
import type { SpawnFn } from "../tools.ts";
import type { Subagent } from "../subagent.ts";
import type { AgentRun, AgentState, TeamMember } from "../types.ts";

const makeMember = (name: string, task = "default task"): TeamMember =>
	Object.freeze({
		name,
		role: "tester",
		instructions: "test",
		task,
		model: "test-model",
		sourceFile: `${name}.yaml`,
	});



let mockInstanceCounter = 0;
const nextMockInstanceId = (name: string): string => `${name}-mock-${++mockInstanceCounter}`;

const makeRun = (state: AgentState, transcript: string, lastError: string | null = null, name = "test"): AgentRun => ({
	name,
	instanceId: nextMockInstanceId(name),
	state,
	task: "",
	startedAt: 1000,
	endedAt: state === "done" || state === "error" ? 2000 : null,
	transcript,
	activity: null,
	lastError,
	pid: null,
});

type SpawnCall = {
	memberName: string;
	task: string;
	signal: AbortSignal | undefined;
	timeoutMs: number | undefined;
};

const makeSpawnRecorder = (
	responses: ReadonlyMap<string, AgentRun>,
): { spawn: SpawnFn; calls: SpawnCall[] } => {
	const calls: SpawnCall[] = [];
	const spawn: SpawnFn = async (member, task, signal, timeoutMs) => {
		calls.push({ memberName: member.name, task, signal, timeoutMs });
		const response = responses.get(member.name);
		if (!response) {
			throw new Error(`no mock response for '${member.name}'`);
		}
		return response;
	};
	return { spawn, calls };
};

// Shared roster for the runAggregate + registerTools tests: scout, worker,
// and aggregator cover the three member-name slots that runAggregate
// distinguishes (parallel task, parallel task, post-aggregation step).
const buildTeam = (): ReadonlyMap<string, TeamMember> =>
	new Map<string, TeamMember>([
		["scout", makeMember("scout")],
		["worker", makeMember("worker")],
		["aggregator", makeMember("aggregator")],
	]);

describe("runAggregate", () => {
	test("runs tasks in parallel and runs the aggregator with {previous} substituted", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "found A")],
			["worker", makeRun("done", "built B")],
			["aggregator", makeRun("done", "summary")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		const params: AggregateArgs = {
			tasks: [
				{ name: "scout", task: "find" },
				{ name: "worker", task: "build" },
			],
			aggregator: { name: "aggregator", task: "Combine:\n{previous}" },
		};

		const result = await runAggregate(params, undefined, () => team, spawn);

		expect(calls).toHaveLength(3);
		const calledNames = new Set([calls[0]!.memberName, calls[1]!.memberName]);
		expect(calledNames).toEqual(new Set(["scout", "worker"]));
		expect(calls[2]!.memberName).toBe("aggregator");

		// The aggregator's task has {previous} replaced with the joined prior outputs.
		expect(calls[2]!.task).toMatch(
			/^Combine:\n=== scout \(test-mock-\d+\) ===\nfound A\n\n=== worker \(test-mock-\d+\) ===\nbuilt B$/,
		);

		expect(result.output).toBe("summary");
		expect(result.tasks).toHaveLength(2);
		expect(result.tasks[0]!.name).toBe("scout");
		expect(result.tasks[0]!.output).toBe("found A");
		expect(result.tasks[1]!.name).toBe("worker");
		expect(result.tasks[1]!.output).toBe("built B");
	});

	test("substitutes {previous} when the placeholder appears multiple times", async () => {
		const team = new Map<string, TeamMember>([["a", makeMember("a")]]);
		const responses = new Map<string, AgentRun>([
			["a", makeRun("done", "x")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runAggregate(
			{
				tasks: [{ name: "a", task: "do" }],
				aggregator: { name: "a", task: "{previous} and {previous}" },
			},
			undefined,
			() => team,
			spawn,
		);

		expect(calls[1]!.task).toMatch(/^=== a \(test-mock-\d+\) ===\nx and === a \(test-mock-\d+\) ===\nx$/);
	});

	test("throws when a task name is unknown", async () => {
		const team = buildTeam();
		const { spawn } = makeSpawnRecorder(new Map());

		await expect(
			runAggregate(
				{
					tasks: [{ name: "scout", task: "find" }],
					aggregator: { name: "ghost", task: "Combine: {previous}" },
				},
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow("unknown agent 'ghost'");
	});

	test("throws when the aggregator name is unknown", async () => {
		const team = new Map<string, TeamMember>([["scout", makeMember("scout")]]);
		const responses = new Map<string, AgentRun>([["scout", makeRun("done", "ok")]]);
		const { spawn } = makeSpawnRecorder(responses);

		await expect(
			runAggregate(
				{
					tasks: [{ name: "scout", task: "find" }],
					aggregator: { name: "ghost", task: "Combine: {previous}" },
				},
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow("unknown agent 'ghost'");
	});

	test("returns partial when a parallel task fails", async () => {
		// Regression: lyra review surfaced that the previous implementation
		// used Promise.all and rethrew on the first failing task, losing
		// the in-flight sibling tasks' outputs. The fix uses
		// Promise.allSettled to collect every task's result and returns
		// a partial result with the first failure.
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("error", "transcript", "boom")],
			["worker", makeRun("done", "ok")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		const result = await runAggregate(
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: { name: "aggregator", task: "Combine: {previous}" },
			},
			undefined,
			() => team,
			spawn,
		);

		expect(result.kind).toBe("partial");
		if (result.kind !== "partial") throw new Error("unreachable");

		// First failure captured with index, name, and reason.
		expect(result.failure.kind).toBe("task");
		if (result.failure.kind !== "task") throw new Error("unreachable");
		expect(result.failure.index).toBe(0);
		expect(result.failure.name).toBe("scout");
		expect(result.failure.reason).toMatch(/^scout \(test-mock-\d+\) failed: boom$/);

		// The completed task is preserved — the worker's output is not lost.
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0]!.name).toBe("worker");
		expect(result.tasks[0]!.output).toBe("ok");

		// The aggregator is NOT spawned once any parallel task fails.
		expect(calls).toHaveLength(2);
	});

	test("returns partial when all parallel tasks fail", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("error", "transcript", "boom1")],
			["worker", makeRun("error", "transcript", "boom2")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		const result = await runAggregate(
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: { name: "aggregator", task: "Combine: {previous}" },
			},
			undefined,
			() => team,
			spawn,
		);

		expect(result.kind).toBe("partial");
		if (result.kind !== "partial") throw new Error("unreachable");

		// No tasks completed.
		expect(result.tasks).toHaveLength(0);

		// The first failure is reported (scout, index 0).
		expect(result.failure.kind).toBe("task");
		if (result.failure.kind !== "task") throw new Error("unreachable");
		expect(result.failure.index).toBe(0);
		expect(result.failure.name).toBe("scout");
		expect(result.failure.reason).toMatch(/^scout \(test-mock-\d+\) failed: boom1$/);

		// The aggregator is NOT spawned.
		expect(calls).toHaveLength(2);
	});

	test("throws on duplicate task name in tasks[]", async () => {
		// Regression: lyra review surfaced that the previous implementation
		// did not check for duplicate names. Promise.all dispatched both
		// spawns in parallel; the second saw the first's "thinking" run
		// and subagent.ts threw "agent 'X' is already running" mid-batch,
		// losing the first's transcript. The fix checks for duplicates at
		// pre-validation.
		const team = buildTeam();
		const { spawn, calls } = makeSpawnRecorder(new Map());

		await expect(
			runAggregate(
				{
					tasks: [
						{ name: "scout", task: "first" },
						{ name: "scout", task: "second" },
					],
					aggregator: { name: "aggregator", task: "Combine: {previous}" },
				},
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow("task 1: duplicate name 'scout' in tasks[]");

		// No spawns occurred — the duplicate check fires before the
		// parallel fan-out.
		expect(calls).toHaveLength(0);
	});

	test("rejects an aggregator whose task is whitespace-only", async () => {
		// Regression: lyra review surfaced that the aggregator path in
		// runAggregate does not .trim() or validate empty tasks, while
		// the parallel-task path does. An empty aggregator task flows
		// to the pi subprocess, which exits immediately — silent failure.
		// (Note: a {previous}-substituted aggregator task can't be
		// empty in practice because formatPriorOutputs always adds
		// "## Result N: ..." labels, so the realistic test is a literal
		// whitespace task — the schema accepts it, the validation must
		// catch it.)
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["worker", makeRun("done", "y")],
		]);
		const { spawn } = makeSpawnRecorder(responses);

		await expect(
			runAggregate(
				{
					tasks: [
						{ name: "scout", task: "find" },
						{ name: "worker", task: "build" },
					],
					aggregator: { name: "aggregator", task: "   " },
				},
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow(/no task supplied for 'aggregator'/);
	});

	test("returns partial when the aggregator fails", async () => {
		// Regression: lyra review surfaced that a failing aggregator was
		// also rethrown, losing the parallel tasks' outputs. The fix
		// returns a partial result with the aggregator's failure and
		// the tasks that did complete.
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "ok")],
			["aggregator", makeRun("error", "transcript", "nope")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		const result = await runAggregate(
			{
				tasks: [{ name: "scout", task: "find" }],
				aggregator: { name: "aggregator", task: "Combine: {previous}" },
			},
			undefined,
			() => team,
			spawn,
		);

		expect(result.kind).toBe("partial");
		if (result.kind !== "partial") throw new Error("unreachable");

		// The aggregator failure is reported separately from task failures.
		expect(result.failure.kind).toBe("aggregator");
		if (result.failure.kind !== "aggregator") throw new Error("unreachable");
		expect(result.failure.name).toBe("aggregator");
		expect(result.failure.reason).toMatch(/^aggregator failed: nope$/);

		// The completed parallel task is preserved.
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0]!.name).toBe("scout");
		expect(result.tasks[0]!.output).toBe("ok");

		// scout + aggregator were both spawned.
		expect(calls).toHaveLength(2);
	});

	test("caps the available-agent list in errors to avoid bloating LLM context", async () => {
		// Regression: lyra review surfaced that formatAvailableAgents
		// joined every team member into every unknown-agent error. For
		// 100+ member rosters, the error string balloons LLM context
		// on every typo. The fix caps the list at 10 with a "...and N
		// more" suffix.
		const team = new Map<string, TeamMember>(
			Array.from({ length: 12 }, (_, i) => [
				`m${String(i).padStart(2, "0")}`,
				makeMember(`m${String(i).padStart(2, "0")}`),
			]),
		);
		const { spawn } = makeSpawnRecorder(new Map());

		const error = await runAggregate(
			{
				tasks: [{ name: "ghost", task: "do" }],
				aggregator: { name: "m00", task: "Combine: {previous}" },
			},
			undefined,
			() => team,
			spawn,
		).then(
			() => null,
			(err: Error) => err,
		);

		expect(error).not.toBeNull();
		expect(error!.message).toContain("and 2 more");
		// The full 12-name list is NOT in the message.
		expect(error!.message).not.toContain("m11");
	});

	test("preserves literal {previous} when written as {{previous}} in an aggregator task", async () => {
		// Mirrors the runChain escape test at the bottom of this file —
		// runAggregate and runChain share the substitutePrevious helper,
		// so the escape must work in both. The aggregator's task contains
		// {{previous}}; it must reach the spawned subprocess verbatim.
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["worker", makeRun("done", "y")],
			["aggregator", makeRun("done", "z")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runAggregate(
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: { name: "aggregator", task: "describe the {{previous}} placeholder" },
			},
			undefined,
			() => team,
			spawn,
		);

		expect(calls).toHaveLength(3);
		// The aggregator received the literal token, NOT the joined prior outputs.
		expect(calls[2]!.task).toBe("describe the {previous} placeholder");
	});

	test("mixes {previous} substitution and {{previous}} escape in one task", async () => {
		// Edge case: a single task contains both an active placeholder
		// (must be substituted) and an escaped literal (must survive).
		// The substitutePrevious helper's order of operations
		// (escape → substitute → restore) is what makes this work.
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["worker", makeRun("done", "y")],
			["aggregator", makeRun("done", "z")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runAggregate(
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: {
					name: "aggregator",
					task: "summarize {previous} and also explain the {{previous}} syntax",
				},
			},
			undefined,
			() => team,
			spawn,
		);

		expect(calls).toHaveLength(3);
		// {previous} is replaced with the joined prior outputs; {{previous}}
		// is restored to the literal token.
		expect(calls[2]!.task).toMatch(
			/^summarize === scout \(test-mock-\d+\) ===\nx\n\n=== worker \(test-mock-\d+\) ===\ny and also explain the \{previous\} syntax$/,
		);
	});

	test("forwards timeoutMs to every spawn", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["worker", makeRun("done", "y")],
			["aggregator", makeRun("done", "z")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runAggregate(
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: { name: "aggregator", task: "Combine: {previous}" },
				timeoutMs: 5000,
			},
			undefined,
			() => team,
			spawn,
		);

		for (const call of calls) {
			expect(call.timeoutMs).toBe(5000);
		}
	});

	test("falls back to the YAML task when step.task is omitted", async () => {
		const team = new Map<string, TeamMember>([["a", makeMember("a", "from yaml")]]);
		const responses = new Map<string, AgentRun>([["a", makeRun("done", "ok")]]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runAggregate(
			{
				tasks: [{ name: "a" }],
				aggregator: { name: "a", task: "{previous}" },
			},
			undefined,
			() => team,
			spawn,
		);

		expect(calls[0]!.task).toBe("from yaml");
	});
});

describe("runChain", () => {
	const buildTeam = (): ReadonlyMap<string, TeamMember> =>
		new Map<string, TeamMember>([
			["scout", makeMember("scout")],
			["planner", makeMember("planner")],
			["worker", makeMember("worker")],
		]);

	test("runs steps sequentially and substitutes {previous} in each step", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "scout output")],
			["planner", makeRun("done", "plan output")],
			["worker", makeRun("done", "worker output")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		const params: ChainArgs = {
			steps: [
				{ name: "scout", task: "scout" },
				{ name: "planner", task: "plan using {previous}" },
				{ name: "worker", task: "implement {previous}" },
			],
		};

		const result = await runChain(params, undefined, () => team, spawn);

		expect(calls).toHaveLength(3);
		// First step has no {previous}, so the task is unchanged.
		expect(calls[0]!.task).toBe("scout");
		// Second step's {previous} is the first step's output.
		expect(calls[1]!.task).toBe("plan using scout output");
		// Third step's {previous} is the second step's output.
		expect(calls[2]!.task).toBe("implement plan output");
		// Result is the last step's output.
		expect(result.output).toBe("worker output");
		expect(result.steps).toHaveLength(3);
		expect(result.steps[2]!.output).toBe("worker output");
	});

	test("replaces an empty {previous} in the first step", async () => {
		const team = new Map<string, TeamMember>([["a", makeMember("a")]]);
		const responses = new Map<string, AgentRun>([["a", makeRun("done", "x")]]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runChain(
			{ steps: [{ name: "a", task: "start: {previous}" }] },
			undefined,
			() => team,
			spawn,
		);

		// The trim step collapses the trailing space that the empty
		// {previous} left behind — "start: " becomes "start:".
		expect(calls[0]!.task).toBe("start:");
	});

	test("falls back to the YAML task when step.task is omitted", async () => {
		const team = new Map<string, TeamMember>([["a", makeMember("a", "from yaml")]]);
		const responses = new Map<string, AgentRun>([["a", makeRun("done", "ok")]]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runChain({ steps: [{ name: "a" }] }, undefined, () => team, spawn);

		expect(calls[0]!.task).toBe("from yaml");
	});

	test("substitutes {previous} into the YAML fallback task", async () => {
		const team = new Map<string, TeamMember>([
			["a", makeMember("a", "step a default")],
			["b", makeMember("b", "step b: {previous}")],
		]);
		const responses = new Map<string, AgentRun>([
			["a", makeRun("done", "alpha")],
			["b", makeRun("done", "beta")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runChain({ steps: [{ name: "a" }, { name: "b" }] }, undefined, () => team, spawn);

		expect(calls[0]!.task).toBe("step a default");
		expect(calls[1]!.task).toBe("step b: alpha");
	});

	test("throws when a step name is unknown", async () => {
		const team = buildTeam();
		const { spawn } = makeSpawnRecorder(new Map());

		await expect(
			runChain(
				{ steps: [{ name: "ghost", task: "do" }] },
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow("step 0: unknown agent 'ghost'");
	});

	test("returns partial when a step fails and stops subsequent steps", async () => {
		// Regression: lyra review surfaced that runChain rethrew on the
		// first failing step, losing the completed steps' outputs and
		// giving the LLM no way to inspect what ran. The fix returns a
		// partial result with the completed steps and the failing step.
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["planner", makeRun("error", "transcript", "nope")],
			["worker", makeRun("done", "should not run")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		const result = await runChain(
			{
				steps: [
					{ name: "scout", task: "scout" },
					{ name: "planner", task: "plan" },
					{ name: "worker", task: "build" },
				],
			},
			undefined,
			() => team,
			spawn,
		);

		expect(result.kind).toBe("partial");
		if (result.kind !== "partial") throw new Error("unreachable");

		// The failure points at the planner step.
		expect(result.failure.index).toBe(1);
		expect(result.failure.name).toBe("planner");
		expect(result.failure.reason).toMatch(/^planner \(test-mock-\d+\) failed: nope$/);

		// The completed scout step is preserved.
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]!.name).toBe("scout");
		expect(result.steps[0]!.output).toBe("x");

		// Worker must NOT have been spawned (chain short-circuits).
		expect(calls).toHaveLength(2);
	});

	test("preserves literal {previous} when written as {{previous}} in a chain step", async () => {
		// Mirrors the runAggregate escape test — see comment there.
		const team = new Map<string, TeamMember>([
			["a", makeMember("a")],
			["b", makeMember("b")],
		]);
		const responses = new Map<string, AgentRun>([
			["a", makeRun("done", "x")],
			["b", makeRun("done", "y")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runChain(
			{
				steps: [
					{ name: "a", task: "find" },
					{ name: "b", task: "discuss the {{previous}} placeholder" },
				],
			},
			undefined,
			() => team,
			spawn,
		);

		// b received the literal token, not a's output.
		expect(calls).toHaveLength(2);
		expect(calls[1]!.task).toBe("discuss the {previous} placeholder");
	});

	test("forwards timeoutMs to every spawn", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["planner", makeRun("done", "y")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await runChain(
			{ steps: [{ name: "scout", task: "s" }, { name: "planner", task: "p" }], timeoutMs: 2500 },
			undefined,
			() => team,
			spawn,
		);

		for (const call of calls) {
			expect(call.timeoutMs).toBe(2500);
		}
	});

	test("rejects a step whose task is whitespace-only (matches runAggregate / spawn behavior)", async () => {
		// Regression: lyra review surfaced that runChain did not .trim()
		// or reject empty tasks, while runAggregate and nano_agent_spawn
		// do. An empty/whitespace task flows to the pi subprocess, which
		// exits immediately because `-p` mode has nothing to process —
		// a silent failure. runChain must apply the same guard.
		const team = new Map<string, TeamMember>([["a", makeMember("a", "")]]);
		const responses = new Map<string, AgentRun>();
		const { spawn } = makeSpawnRecorder(responses);

		await expect(
			runChain(
				{ steps: [{ name: "a", task: "   " }] },
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow(/no task supplied for 'a'/);
	});

	test("rejects a step whose task is whitespace-only even after {previous} substitution", async () => {
		// {previous} substitution can produce whitespace if the previous
		// step returned ""; trim+empty check must happen AFTER replaceAll
		// so a chain that resolves to all-whitespace task is rejected.
		const team = new Map<string, TeamMember>([["a", makeMember("a", "")]]);
		const responses = new Map<string, AgentRun>([["a", makeRun("done", "   ")]]);
		const { spawn } = makeSpawnRecorder(responses);

		await expect(
			runChain(
				{ steps: [{ name: "a", task: "{previous}" }] },
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow(/no task supplied for 'a'/);
	});
});

// ── registerTools: execute() surface ──

// Captures the `execute` function passed to each pi.registerTool call so
// tests can invoke the tool handler directly. This is the only way to
// exercise the partial-kind → LLM-text path without spinning up a real
// pi ExtensionAPI. The `asTextContent` helper in tools.ts wraps the text
// in a `{ type: "text", text }` block, so the captured content shape
// matches what pi actually sees.
type CapturedExecute = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
) => Promise<{
	content: readonly { type: "text"; text: string }[];
	details: unknown;
}>;

const captureExecute = (): {
	pi: ExtensionAPI;
	captured: Map<string, CapturedExecute>;
	descriptions: Map<string, { description: string; promptSnippet: string }>;
} => {
	const captured = new Map<string, CapturedExecute>();
	const descriptions = new Map<string, { description: string; promptSnippet: string }>();
	// Minimal ExtensionAPI stand-in: only registerTool is exercised by
	// registerTools, so the rest of the surface is intentionally absent.
	// The cast at the end is the standard test-only pattern for this kind
	// of dependency isolation.
	const pi = {
		registerTool: (def: {
			name: string;
			description: string;
			promptSnippet: string;
			execute: CapturedExecute;
		}) => {
			captured.set(def.name, def.execute);
			descriptions.set(def.name, { description: def.description, promptSnippet: def.promptSnippet });
		},
	} as unknown as ExtensionAPI;
	return { pi, captured, descriptions };
};

// registerTools only ever calls `subagent.spawn` (via the local `spawn`
// constant at tools.ts:493-494). The other methods on the Subagent
// interface are stubbed out so the mock type-checks. The status-tool tests
// (below) need getByName / getLiveByName to return controlled data, so
// the mock accepts optional overrides; the default of `() => []` covers
// the aggregate / chain tests which never touch the status tool.
type SubagentStateOverrides = {
	getByName?: (name: string) => readonly Readonly<AgentRun>[];
	getLiveByName?: (name: string) => readonly Readonly<AgentRun>[];
};
const mockSubagent = (spawn: SpawnFn, overrides: SubagentStateOverrides = {}): Subagent => ({
	spawn,
	kill: () => false,
	list: () => [],
	get: () => undefined,
	getByName: (overrides.getByName ?? (() => [])) as (name: string) => readonly Readonly<AgentRun>[],
	getLiveByName: (overrides.getLiveByName ?? (() => [])) as (name: string) => readonly Readonly<AgentRun>[],
	subscribe: () => () => {},
	shutdown: () => {},
});

describe("registerTools", () => {
	test("nano_agent_aggregate execute() returns done content+details on success", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "found it")],
			["worker", makeRun("done", "built it")],
			["aggregator", makeRun("done", "summary text")],
		]);
		const { spawn } = makeSpawnRecorder(responses);
		const { pi, captured } = captureExecute();
		registerTools(pi, mockSubagent(spawn), () => team);

		const execute = captured.get("nano_agent_aggregate");
		expect(execute).toBeDefined();
		const result = await execute!(
			"call-id",
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: { name: "aggregator", task: "summarize {previous}" },
			} satisfies AggregateArgs,
			undefined,
		);

		// The aggregator's transcript is what the LLM sees as text.
		expect(result.content[0]!.text).toBe("summary text");
		// The details object carries the kind discriminator and the structured data.
		expect(result.details).toMatchObject({
			kind: "done",
			tasks: [
				{ name: "scout", output: "found it" },
				{ name: "worker", output: "built it" },
			],
			aggregatorRun: { state: "done", transcript: "summary text" },
		});
	});

	test("nano_agent_aggregate execute() returns formatted partial text and partial details on task failure", async () => {
		// Regression: the partial-kind path was unverified before this
		// commit. The LLM should see the completed tasks' outputs + the
		// failure descriptor in the text, and a kind="partial" tag in
		// details so any downstream consumer can branch on it.
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("error", "", "boom")],
			["worker", makeRun("done", "ok")],
		]);
		const { spawn } = makeSpawnRecorder(responses);
		const { pi, captured } = captureExecute();
		registerTools(pi, mockSubagent(spawn), () => team);

		const execute = captured.get("nano_agent_aggregate")!;
		const result = await execute(
			"call-id",
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: { name: "aggregator", task: "summarize {previous}" },
			} satisfies AggregateArgs,
			undefined,
		);

		expect(result.details).toEqual({
			kind: "partial",
			tasks: [{ name: "worker", output: "ok", instanceId: expect.stringMatching(/test-mock-\d+/) }],
			failure: {
				kind: "task",
				index: 0,
				name: "scout",
				reason: expect.stringMatching(/^scout \(test-mock-\d+\) failed: boom$/),
			},
		});

		const text = result.content[0]!.text;
		expect(text).toContain("Partial aggregate: 1 of 2 tasks completed before failure.");
		expect(text).toMatch(/=== worker \(test-mock-\d+\) ===/);
		expect(text).toContain("ok");
		expect(text).toMatch(/Failure: task 0 \('scout'\) failed: scout \(test-mock-\d+\) failed: boom/);
	});

	test("nano_agent_aggregate execute() returns partial with failure.kind='aggregator' when the aggregator fails", async () => {
		// Symmetric to the task-failure case: the failure discriminator is
		// 'aggregator' and the `index` field is absent (task-only field).
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["aggregator", makeRun("error", "", "nope")],
		]);
		const { spawn } = makeSpawnRecorder(responses);
		const { pi, captured } = captureExecute();
		registerTools(pi, mockSubagent(spawn), () => team);

		const execute = captured.get("nano_agent_aggregate")!;
		const result = await execute(
			"call-id",
			{
				tasks: [{ name: "scout", task: "find" }],
				aggregator: { name: "aggregator", task: "summarize {previous}" },
			} satisfies AggregateArgs,
			undefined,
		);

		const failure = (
			result.details as {
				failure: { kind: string; index?: number; name: string; reason: string };
			}
		).failure;
		expect(failure.kind).toBe("aggregator");
		expect(failure.name).toBe("aggregator");
		expect(failure.reason).toMatch(/^aggregator failed: nope$/);
		expect(failure).not.toHaveProperty("index");

		// The completed scout output is preserved in the structured details.
		expect(
			(result.details as { tasks: readonly { name: string; output: string }[] }).tasks,
		).toEqual([{ name: "scout", output: "x", instanceId: expect.stringMatching(/test-mock-\d+/) }]);
	});

	test("nano_agent_aggregate execute() handles 'all tasks failed' partial (0 of N completed)", async () => {
		// Edge case: the formatter's "(no tasks completed)" branch is
		// exercised when every parallel task fails. The LLM must still see
		// a coherent summary with the first failure.
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("error", "", "boom1")],
			["worker", makeRun("error", "", "boom2")],
		]);
		const { spawn } = makeSpawnRecorder(responses);
		const { pi, captured } = captureExecute();
		registerTools(pi, mockSubagent(spawn), () => team);

		const execute = captured.get("nano_agent_aggregate")!;
		const result = await execute(
			"call-id",
			{
				tasks: [
					{ name: "scout", task: "find" },
					{ name: "worker", task: "build" },
				],
				aggregator: { name: "aggregator", task: "summarize {previous}" },
			} satisfies AggregateArgs,
			undefined,
		);

		expect(
			(result.details as { tasks: readonly { name: string; output: string }[] }).tasks,
		).toEqual([]);
		const text = result.content[0]!.text;
		expect(text).toContain("Partial aggregate: 0 of 2 tasks completed before failure.");
		expect(text).toContain("(no tasks completed)");
		expect(text).toMatch(/Failure: task 0 \('scout'\) failed: scout \(test-mock-\d+\) failed: boom1/);
	});

	test("nano_agent_chain execute() returns done content+details on success", async () => {
		const team = new Map<string, TeamMember>([
			["a", makeMember("a")],
			["b", makeMember("b")],
		]);
		const responses = new Map<string, AgentRun>([
			["a", makeRun("done", "x")],
			["b", makeRun("done", "y")],
		]);
		const { spawn } = makeSpawnRecorder(responses);
		const { pi, captured } = captureExecute();
		registerTools(pi, mockSubagent(spawn), () => team);

		const execute = captured.get("nano_agent_chain");
		expect(execute).toBeDefined();
		const result = await execute!(
			"call-id",
			{
				steps: [
					{ name: "a", task: "first" },
					{ name: "b", task: "second" },
				],
			} satisfies ChainArgs,
			undefined,
		);

		expect(result.content[0]!.text).toBe("y");
		expect(result.details).toEqual({
			kind: "done",
			steps: [
				{ name: "a", output: "x", instanceId: expect.stringMatching(/test-mock-\d+/) },
				{ name: "b", output: "y", instanceId: expect.stringMatching(/test-mock-\d+/) },
			],
		});
	});

	test("nano_agent_chain execute() returns formatted partial text and partial details on step failure", async () => {
		// Mirror of the aggregate partial-kind test for chain: the failure
		// has index + name + reason (no kind discriminator — chain only
		// has step failures, not a separate "aggregator" kind).
		const team = new Map<string, TeamMember>([
			["a", makeMember("a")],
			["b", makeMember("b")],
		]);
		const responses = new Map<string, AgentRun>([
			["a", makeRun("done", "x")],
			["b", makeRun("error", "", "nope")],
		]);
		const { spawn } = makeSpawnRecorder(responses);
		const { pi, captured } = captureExecute();
		registerTools(pi, mockSubagent(spawn), () => team);

		const execute = captured.get("nano_agent_chain")!;
		const result = await execute(
			"call-id",
			{
				steps: [
					{ name: "a", task: "first" },
					{ name: "b", task: "second" },
				],
			} satisfies ChainArgs,
			undefined,
		);

		expect(result.details).toEqual({
			kind: "partial",
			steps: [{ name: "a", output: "x", instanceId: expect.stringMatching(/test-mock-\d+/) }],
			failure: {
				index: 1,
				name: "b",
				reason: expect.stringMatching(/^b \(test-mock-\d+\) failed: nope$/),
			},
		});

		const text = result.content[0]!.text;
		expect(text).toContain("Partial chain: 1 of 2 steps completed before failure.");
		expect(text).toMatch(/=== a \(test-mock-\d+\) ===/);
		expect(text).toContain("x");
		expect(text).toMatch(/Failure: step 1 \('b'\) failed: b \(test-mock-\d+\) failed: nope/);
	});

	describe("nano_agent_status", () => {
		test("returns historical summary when name has prior runs but no live", async () => {
			const team = buildTeam();
			const historical = [
				makeRun("done", "result 1", null, "scout"),
				makeRun("done", "result 2", null, "scout"),
				makeRun("done", "result 3", null, "scout"),
			];
			const { spawn } = makeSpawnRecorder(new Map());
			const { pi, captured } = captureExecute();
			registerTools(
				pi,
				mockSubagent(spawn, {
					getByName: (name) => (name === "scout" ? historical : []),
					getLiveByName: () => [],
				}),
				() => team,
			);

			const execute = captured.get("nano_agent_status");
			expect(execute).toBeDefined();
			const result = await execute!("call-id", { name: "scout" }, undefined);

			const text = result.content[0]!.text;
			expect(text).toContain("3 historical runs");
			expect(text).toContain(historical[0]!.instanceId);
			expect(text).toContain(historical[1]!.instanceId);
			expect(text).toContain(historical[2]!.instanceId);
			// The "never spawned" message is for a different case (truly no runs
			// in this session). It must not appear here, otherwise the LLM caller
			// draws the same wrong conclusion the blitz aggregator did.
			expect(text).not.toContain("has never been spawned");
			expect(text).toContain("pass instanceId to inspect one");
		});

		test("uses singular 'run' when name has exactly one historical run", async () => {
			const team = buildTeam();
			const historical = [makeRun("done", "only result", null, "scout")];
			const { spawn } = makeSpawnRecorder(new Map());
			const { pi, captured } = captureExecute();
			registerTools(
				pi,
				mockSubagent(spawn, {
					getByName: (name) => (name === "scout" ? historical : []),
					getLiveByName: () => [],
				}),
				() => team,
			);

			const execute = captured.get("nano_agent_status");
			const result = await execute!("call-id", { name: "scout" }, undefined);

			const text = result.content[0]!.text;
			expect(text).toContain("1 historical run ");
			expect(text).not.toContain("1 historical runs");
		});

		test("returns 'has never been spawned' when getByName is empty", async () => {
			const team = buildTeam();
			const { spawn } = makeSpawnRecorder(new Map());
			const { pi, captured } = captureExecute();
			registerTools(
				pi,
				mockSubagent(spawn, {
					getByName: () => [],
					getLiveByName: () => [],
				}),
				() => team,
			);

			const execute = captured.get("nano_agent_status");
			const result = await execute!("call-id", { name: "scout" }, undefined);

			expect(result.content[0]!.text).toBe("agent 'scout' has never been spawned");
		});

		test("tool description disambiguates live vs historical state (regression guard)", () => {
			const { pi, descriptions } = captureExecute();
			const { spawn } = makeSpawnRecorder(new Map());
			registerTools(pi, mockSubagent(spawn), () => buildTeam());

			const statusTool = descriptions.get("nano_agent_status");
			expect(statusTool).toBeDefined();
			// The description must call out the "no live ≠ never spawned" trap
			// that motivated task 10.1, name the historical terminology, and
			// reference the "never been spawned" message. If any of these
			// three load-bearing tokens drift, the LLM caller reverts to the
			// same misread that motivated task 10.1.
			const desc = statusTool!.description.toLowerCase();
			expect(desc).toContain("historical");
			expect(desc).toContain("never been spawned");
			expect(desc).toContain("no live");
		});
	});
});
