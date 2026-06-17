import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubagent, type Subagent } from "./src/subagent.ts";
import { loadTeam } from "./src/team.ts";
import { registerTools } from "./src/tools.ts";
import {
	type Clock,
	createWidgetFlusher,
	FALLBACK_TERMINAL_COLS,
	type WidgetFlusher,
	type WidgetSink,
	WIDGET_PLACEMENT,
} from "./src/flusher.ts";
import { LIVE_AGENT_STATES, type TeamMember } from "./src/types.ts";

const TASK_SUMMARY_MAX_CHARS = 80;

const summarizeTask = (task: string): string => {
	const firstLine = task.split("\n")[0]?.trim() ?? "";
	if (firstLine.length === 0) return "(no default task)";
	return firstLine.length <= TASK_SUMMARY_MAX_CHARS
		? firstLine
		: `${firstLine.slice(0, TASK_SUMMARY_MAX_CHARS - 1)}…`;
};

const formatTeamMember = (member: TeamMember): string =>
	`- \`${member.name}\` (${member.role}, ${member.model ?? "default"}) — ${summarizeTask(member.task)}`;

const renderRoster = (team: ReadonlyMap<string, TeamMember>): string =>
	team.size === 0
		? "(none defined yet)"
		: Array.from(team.values(), formatTeamMember).join("\n");

const STATIC_GUIDANCE =
	"`nano_agent_spawn(name, task?, timeoutMs?)` runs an agent and returns its final output (`task` overrides the YAML default). " +
	"`nano_agent_kill(name)` aborts; `nano_agent_status(name?)` inspects. " +
	"`nano_agent_aggregate(tasks, aggregator, timeoutMs?)` runs N agents in parallel and an aggregator whose task may reference `{previous}`. " +
	"`nano_agent_chain(steps, timeoutMs?)` runs agents sequentially, substituting each step's output for `{previous}` in the next. " +
	"Issue several `spawn`/`aggregate`/`chain` calls in one turn for parallel work; chain outputs by feeding one agent's result into the next `task`.\n\n" +
	"Add a member: YAML at `.pi/nano-team/team/<name>.yaml` with required fields `name`, `role` (one lowercased word), `instructions`, `task`. `model` is optional — omit it to inherit pi's default. `/reload` after editing. " +
	"Run `/subagents-doctor` to diagnose the setup.";

const buildSystemPromptAddition = (team: ReadonlyMap<string, TeamMember>): string =>
	`# nano-team subagents\n\nRoster:\n${renderRoster(team)}\n\n${STATIC_GUIDANCE}`;

const realClock = (): Clock => ({
	now: () => Date.now(),
	setTimeout: (fn, ms) => {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return { cancel: () => clearTimeout(handle) };
	},
	setInterval: (fn, ms) => {
		const handle = setInterval(fn, ms);
		handle.unref?.();
		return { cancel: () => clearInterval(handle) };
	},
});

const piUiSink = (ctx: ExtensionContext): WidgetSink => ({
	setWidget: (key, lines, opts) => {
		if (ctx.hasUI) ctx.ui.setWidget(key, lines, opts);
	},
});

export default function nanoTeam(pi: ExtensionAPI): void {
	let team: ReadonlyMap<string, TeamMember> = new Map();
	let loadErrors: readonly string[] = [];
	let subagent: Subagent | null = null;
	let flusher: WidgetFlusher | null = null;
	let unsubscribe: (() => void) | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const result = await loadTeam(ctx.cwd);
		team = result.team;
		loadErrors = result.errors;

		if (ctx.hasUI && result.errors.length > 0) {
			ctx.ui.notify(`nano-team: ${result.errors.join("; ")}`, "warning");
		}

		subagent = createSubagent(ctx.cwd);
		flusher = createWidgetFlusher({
			clock: realClock(),
			sink: piUiSink(ctx),
			getRunner: () => subagent,
			getTeam: () => team,
			getCols: () => process.stdout.columns ?? FALLBACK_TERMINAL_COLS,
			theme: ctx.ui.theme,
			setStatus: (text) => {
				if (ctx.hasUI) ctx.ui.setStatus("nano-team", text);
			},
		});
		unsubscribe = subagent.subscribe(() => flusher?.schedule());
		registerTools(pi, subagent, () => team);
		flusher.schedule();
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptAddition(team)}`,
	}));

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = null;
		flusher?.dispose();
		subagent?.shutdown();
		flusher = null;
		subagent = null;
	});

	pi.registerCommand("subagents-doctor", {
		description: "Print diagnostic information about the nano-team setup.",
		handler: (_args, ctx) => {
			const lines: string[] = ["# nano-team diagnostic", ""];
			lines.push(`- cwd: \`${ctx.cwd}\``);
			lines.push(`- pi binary: \`${process.execPath}\``);
			lines.push(
				`- team: ${team.size} member${team.size === 1 ? "" : "s"}${team.size === 0 ? "" : ` (${[...team.keys()].join(", ")})`}`,
			);
			if (loadErrors.length === 0) {
				lines.push(`- load errors: none`);
			} else {
				lines.push(`- load errors: ${loadErrors.length}`);
				for (const err of loadErrors) lines.push(`  - ${err}`);
			}
			lines.push(`- subagent: ${subagent === null ? "not initialized (run a session first)" : "ready"}`);
			const runs = subagent?.list() ?? [];
			const liveCount = runs.filter((run) => LIVE_AGENT_STATES.has(run.state)).length;
			lines.push(`- active runs: ${runs.length} total, ${liveCount} live`);
			for (const run of runs) {
				const activity = run.activity ? ` — ${run.activity}` : "";
				lines.push(`  - \`${run.name}\`: ${run.state}${activity}`);
			}
			// Use a dedicated widget key so the flusher's "nano-team" widget
			// doesn't overwrite this one. The handler is Promise<void> — a
			// returned string would be discarded.
			ctx.ui.setWidget("nano-team-doctor", lines, { placement: WIDGET_PLACEMENT });
		},
	});
}
