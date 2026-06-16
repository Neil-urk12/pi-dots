import { describe, expect, test } from "bun:test";
import {
	runAggregate,
	runChain,
	type AggregateArgs,
	type ChainArgs,
} from "../tools.ts";
import type { SpawnFn } from "../tools.ts";
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

const makeRun = (state: AgentState, transcript: string, lastError: string | null = null): AgentRun => ({
	name: "test",
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

describe("runAggregate", () => {
	const buildTeam = (): ReadonlyMap<string, TeamMember> =>
		new Map<string, TeamMember>([
			["scout", makeMember("scout")],
			["worker", makeMember("worker")],
			["aggregator", makeMember("aggregator")],
		]);

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
		expect(calls[2]!.task).toBe(
			"Combine:\n=== scout ===\nfound A\n\n=== worker ===\nbuilt B",
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

		expect(calls[1]!.task).toBe("=== a ===\nx and === a ===\nx");
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

	test("throws when one of the parallel tasks fails", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("error", "transcript", "boom")],
			["worker", makeRun("done", "ok")],
		]);
		const { spawn } = makeSpawnRecorder(responses);

		await expect(
			runAggregate(
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
			),
		).rejects.toThrow("scout failed: boom");
	});

	test("throws when the aggregator fails", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "ok")],
			["aggregator", makeRun("error", "transcript", "nope")],
		]);
		const { spawn } = makeSpawnRecorder(responses);

		await expect(
			runAggregate(
				{
					tasks: [{ name: "scout", task: "find" }],
					aggregator: { name: "aggregator", task: "Combine: {previous}" },
				},
				undefined,
				() => team,
				spawn,
			),
		).rejects.toThrow("aggregator 'aggregator' failed: nope");
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

		expect(calls[0]!.task).toBe("start: ");
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

	test("stops and throws when a step fails", async () => {
		const team = buildTeam();
		const responses = new Map<string, AgentRun>([
			["scout", makeRun("done", "x")],
			["planner", makeRun("error", "transcript", "nope")],
			["worker", makeRun("done", "should not run")],
		]);
		const { spawn, calls } = makeSpawnRecorder(responses);

		await expect(
			runChain(
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
			),
		).rejects.toThrow("step 1 ('planner') failed: nope");

		// Worker must not have been spawned.
		expect(calls).toHaveLength(2);
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
});
