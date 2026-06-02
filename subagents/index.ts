import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createRunner, type Runner } from "./src/runner.ts";
import { loadTeam } from "./src/team.ts";
import { registerTools } from "./src/tools.ts";
import { LIVE_AGENT_STATES, type TeamMember } from "./src/types.ts";
import { renderChips } from "./src/widget.ts";

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

const WIDGET_KEY = "nano-team";
const FLUSH_DEBOUNCE_MS = 50;
const ANIMATION_FRAME_MS = 300;
const FALLBACK_TERMINAL_COLS = 80;

type WidgetFlusher = Readonly<{ schedule: () => void; cancel: () => void }>;

const createWidgetFlusher = (
	ctx: ExtensionContext,
	getRunner: () => Runner | null,
	getTeam: () => ReadonlyMap<string, TeamMember>,
): WidgetFlusher => {
	let pendingTimer: NodeJS.Timeout | null = null;
	let animationTimer: NodeJS.Timeout | null = null;

	const stopAnimation = (): void => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = null;
	};

	const flush = (): void => {
		pendingTimer = null;
		const runner = ctx.hasUI ? getRunner() : null;
		if (!runner) {
			stopAnimation();
			return;
		}
		const runs = runner.list();
		const lines = renderChips(
			runs,
			getTeam(),
			process.stdout.columns ?? FALLBACK_TERMINAL_COLS,
			ctx.ui.theme,
			Math.floor(Date.now() / ANIMATION_FRAME_MS),
		);
		ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });

		const hasLiveAgent = runs.some((run) => LIVE_AGENT_STATES.has(run.state));
		if (hasLiveAgent && !animationTimer) {
			animationTimer = setInterval(flush, ANIMATION_FRAME_MS);
			animationTimer.unref?.();
		} else if (!hasLiveAgent) {
			stopAnimation();
		}
	};

	return {
		schedule: () => {
			if (pendingTimer) return;
			pendingTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
		},
		cancel: () => {
			if (pendingTimer) {
				clearTimeout(pendingTimer);
				pendingTimer = null;
			}
			stopAnimation();
		},
	};
};

export default function nanoTeam(pi: ExtensionAPI): void {
	let team: ReadonlyMap<string, TeamMember> = new Map();
	let runner: Runner | null = null;
	let flusher: WidgetFlusher | null = null;

	pi.on("session_start", async (_event, ctx) => {
		const result = await loadTeam(ctx.cwd);
		team = result.team;

		if (ctx.hasUI && result.errors.length > 0) {
			ctx.ui.notify(`nano-team: ${result.errors.join("; ")}`, "warning");
		}

		flusher = createWidgetFlusher(ctx, () => runner, () => team);
		runner = createRunner(ctx.cwd, () => flusher?.schedule());
		registerTools(pi, runner, () => team);
		flusher.schedule();
	});

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildSystemPromptAddition(team)}`,
	}));

	pi.on("session_shutdown", () => {
		flusher?.cancel();
		runner?.shutdown();
		runner = null;
		flusher = null;
	});
}
