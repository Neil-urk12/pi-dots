import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { NodeClock } from "./src/clock.ts";
import { createWidgetFlusher, type WidgetFlusher } from "./src/flusher.ts";
import { createSubagent, type Subagent } from "./src/subagent.ts";
import { loadTeam } from "./src/team.ts";
import { registerTools } from "./src/tools.ts";
import { type TeamMember } from "./src/types.ts";

const TASK_SUMMARY_MAX_CHARS = 80;

const summarizeTask = (task: string): string => {
	const firstLine = task.split("\n")[0]?.trim() ?? "";
	if (firstLine.length === 0) return "(no default task)";
	return firstLine.length <= TASK_SUMMARY_MAX_CHARS
		? firstLine
		: `${firstLine.slice(0, TASK_SUMMARY_MAX_CHARS - 1)}…`;
};

const formatTeamMember = (member: TeamMember): string =>
	`- \`${member.name}\` (${member.role}, ${member.model}) — ${summarizeTask(member.task)}`;

const renderRoster = (team: ReadonlyMap<string, TeamMember>): string =>
	team.size === 0
		? "(none defined yet)"
		: Array.from(team.values(), formatTeamMember).join("\n");

const STATIC_GUIDANCE =
	"`nano_agent_spawn(name, task?)` runs an agent and returns its final output (`task` overrides the YAML default). `nano_agent_kill(name)` aborts; `nano_agent_status(name?)` inspects. Issue several `spawn` calls in one turn for parallel work; chain by passing one agent's output as the next agent's `task`.\n\n" +
	"Add a member: YAML at `.pi/nano-team/team/<name>.yaml` with fields `name`, `role` (one lowercased word), `model`, `instructions`, `task`. `/reload` after editing.";

const buildSystemPromptAddition = (team: ReadonlyMap<string, TeamMember>): string =>
	`# nano-team subagents\n\nRoster:\n${renderRoster(team)}\n\n${STATIC_GUIDANCE}`;

const FALLBACK_TERMINAL_COLS = 80;

export default function nanoTeam(pi: ExtensionAPI): void {
	let team: ReadonlyMap<string, TeamMember> = new Map();
	let subagent: Subagent | null = null;
	let flusher: WidgetFlusher | null = null;
	let unsubscribe: (() => void) | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const result = await loadTeam(ctx.cwd);
		team = result.team;

		if (ctx.hasUI && result.errors.length > 0) {
			ctx.ui.notify(`nano-team: ${result.errors.join("; ")}`, "warning");
		}

		subagent = createSubagent(ctx.cwd);

		if (ctx.hasUI) {
			flusher = createWidgetFlusher({
				clock: new NodeClock(),
				sink: {
					setWidget: (key, lines, opts) =>
						ctx.ui.setWidget(key, lines as string[] | undefined, opts),
				},
				getRunner: () => subagent,
				getTeam: () => team,
				getCols: () => process.stdout.columns ?? FALLBACK_TERMINAL_COLS,
				theme: ctx.ui.theme,
			});
			unsubscribe = subagent.subscribe(() => flusher?.schedule());
		}
		registerTools(pi, subagent, () => team);
		flusher?.schedule();
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptAddition(team)}`,
	}));

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = null;
		flusher?.cancel();
		subagent?.shutdown();
		subagent = null;
		flusher = null;
	});
}
