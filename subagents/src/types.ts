export type AgentState = "idle" | "thinking" | "working" | "done" | "error";

export type TeamMember = Readonly<{
	name: string;
	role: string;
	instructions: string;
	task: string;
	model: string;
	sourceFile: string;
}>;

export type AgentRun = Readonly<{
	name: string;
	state: AgentState;
	task: string;
	startedAt: number;
	endedAt: number | null;
	transcript: string;
	activity: string | null;
	lastError: string | null;
	pid: number | null;
}>;

export const LIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set(["thinking", "working"]);

export const createInitialRun = (name: string, task = ""): AgentRun => ({
	name,
	state: "idle",
	task,
	startedAt: 0,
	endedAt: null,
	transcript: "",
	activity: null,
	lastError: null,
	pid: null,
});
