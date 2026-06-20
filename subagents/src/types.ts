export type AgentState = "idle" | "thinking" | "working" | "done" | "error";

export type TeamMember = Readonly<{
	name: string;
	role: string;
	instructions: string;
	task: string;
	model?: string;
	description?: string;
	/**
	 * When true, multiple live instances of this agent may run concurrently.
	 * Defaults to false; opt-in only via the agent's YAML/markdown source.
	 */
	readOnly?: boolean;
	sourceFile: string;
}>;

// AgentRun is intentionally NOT Readonly<...>: the Subagent lifecycle
// replaces the run object on every state transition via
// `{ ...previous, ...patch }` (see updateRun in subagent.ts). The Readonly
// wrapper was a compile-time lie that hid this replacement pattern.
export type AgentRun = {
	name: string;
	/**
	 * Stable, human-readable identifier of the form `${name}-${n}` where `n`
	 * is a per-name monotonic counter. Unique across all concurrent runs of
	 * the same agent name. Scoped to the Subagent's lifetime.
	 */
	instanceId: string;
	state: AgentState;
	task: string;
	startedAt: number;
	endedAt: number | null;
	transcript: string;
	activity: string | null;
	lastError: string | null;
	pid: number | null;
};

export const LIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set(["thinking", "working"]);

/**
 * Type-guard form of `LIVE_AGENT_STATES.has` — narrows `AgentState` to
 * `"thinking" | "working"` inside the `if` branch, which the Set's
 * `.has` cannot do because TypeScript's `ReadonlySet.has` returns
 * `boolean`, not a type predicate.
 */
export const isLiveState = (state: AgentState): state is "thinking" | "working" =>
	LIVE_AGENT_STATES.has(state);

export const createInitialRun = (name: string, instanceId: string, task = ""): AgentRun => ({
	name,
	instanceId,
	state: "idle",
	task,
	startedAt: 0,
	endedAt: null,
	transcript: "",
	activity: null,
	lastError: null,
	pid: null,
});
