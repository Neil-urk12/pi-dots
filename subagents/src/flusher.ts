import { LIVE_AGENT_STATES, type AgentRun, type TeamMember } from "./types.ts";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { renderChips } from "./widget.ts";

export type TimerHandle = Readonly<{ cancel(): void }>;

export type Clock = Readonly<{
	now(): number;
	setTimeout(fn: () => void, ms: number): TimerHandle;
	setInterval(fn: () => void, ms: number): TimerHandle;
}>;

export const WIDGET_KEY = "nano-team";
export const WIDGET_PLACEMENT = "aboveEditor" as const;
export const FLUSH_DEBOUNCE_MS = 50;
export const ANIMATION_FRAME_MS = 300;
export const FALLBACK_TERMINAL_COLS = 80;

export type WidgetSink = Readonly<{
	setWidget(
		key: string,
		lines: readonly string[] | undefined,
		opts: { placement: typeof WIDGET_PLACEMENT },
	): void;
}>;

export type WidgetFlusher = Readonly<{
	schedule(): void;
	cancel(): void;
	tick(now: number): void;
	dispose(): void;
}>;

export type WidgetFlusherDeps = Readonly<{
	clock: Clock;
	sink: WidgetSink;
	getRunner: () => RunnerLike | null;
	getTeam: () => ReadonlyMap<string, TeamMember>;
	getCols: () => number;
	theme: Theme;
	setStatus?: (text: string | undefined) => void;
}>;

type RunnerLike = Readonly<{ list(): readonly AgentRun[] }>;

/**
 * Build a one-line status summary of the live swarm. Returns undefined when
 * nothing is live, so callers can clear the status line.
 *
 * Examples:
 *   ("scout: thinking · worker: working", team=2)     → "scout: thinking · worker: working"
 *   ("scout: thinking", team=3)                       → "scout: thinking · 2 idle"
 *   ([], team=3)                                      → undefined
 */
export const formatStatusText = (
	runs: readonly AgentRun[],
	team: ReadonlyMap<string, TeamMember>,
): string | undefined => {
	const liveRuns = runs.filter((run) => LIVE_AGENT_STATES.has(run.state));
	if (liveRuns.length === 0) return undefined;
	const live = liveRuns.map((run) => `${run.name}: ${run.state}`).join(" · ");
	const idleCount = team.size - liveRuns.length;
	return idleCount > 0 ? `${live} · ${idleCount} idle` : live;
};

export const createWidgetFlusher = (deps: WidgetFlusherDeps): WidgetFlusher => {
	let pendingTimer: TimerHandle | null = null;
	let animationTimer: TimerHandle | null = null;

	const disarmAnimation = (): void => {
		if (animationTimer) {
			animationTimer.cancel();
			animationTimer = null;
		}
	};

	const tick = (now: number): void => {
		pendingTimer = null;
		const runner = deps.getRunner();
		if (!runner) {
			disarmAnimation();
			deps.sink.setWidget(WIDGET_KEY, undefined, { placement: WIDGET_PLACEMENT });
			deps.setStatus?.(undefined);
			return;
		}
		const runs = runner.list();
		const lines = renderChips(
			runs,
			deps.getTeam(),
			deps.getCols(),
			deps.theme,
			Math.floor(now / ANIMATION_FRAME_MS),
		);
		deps.sink.setWidget(
			WIDGET_KEY,
			lines.length > 0 ? lines : undefined,
			{ placement: WIDGET_PLACEMENT },
		);
		deps.setStatus?.(formatStatusText(runs, deps.getTeam()));
		const hasLiveAgent = runs.some((run) => LIVE_AGENT_STATES.has(run.state));
		disarmAnimation();
		if (hasLiveAgent) {
			animationTimer = deps.clock.setInterval(
				() => tick(deps.clock.now()),
				ANIMATION_FRAME_MS,
			);
		}
	};

	return {
		schedule: () => {
			if (pendingTimer) return;
			pendingTimer = deps.clock.setTimeout(() => tick(deps.clock.now()), FLUSH_DEBOUNCE_MS);
		},
		cancel: () => {
			if (pendingTimer) {
				pendingTimer.cancel();
				pendingTimer = null;
			}
			disarmAnimation();
		},
		tick: (now: number) => tick(now),
		dispose: () => {
			if (pendingTimer) {
				pendingTimer.cancel();
				pendingTimer = null;
			}
			disarmAnimation();
			deps.sink.setWidget(WIDGET_KEY, undefined, { placement: WIDGET_PLACEMENT });
			deps.setStatus?.(undefined);
		},
	};
};
