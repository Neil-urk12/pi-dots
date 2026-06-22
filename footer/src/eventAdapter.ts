import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { defaultConfig } from "./configPresets.js";
import { loadFooterConfig } from "./config.js";
import type { ResolvedConfig } from "./configTypes.js";
import { createGitState, type GitStateHandle } from "./git.js";
import { normalizeThinkingLevel } from "./utils.js";
import { createToksActivity, type ToksActivityHandle } from "./toksActivity.js";
import type { FooterInput, Totals } from "./types.js";
/**
 * Type guard for objects that carry a `.usage` record.
 */
export function hasUsage(obj: unknown): obj is { usage: Record<string, unknown> } {
	return (
		obj !== null &&
		typeof obj === "object" &&
		"usage" in obj &&
		obj.usage !== null &&
		typeof obj.usage === "object"
	);
}

/**
 * Extract output-token count from a message-like object.
 *
 * Checks `msg.usage.output` first, then `msg.message.usage.output`.
 * Returns `undefined` when the value is missing, non-numeric, or < 0.
 */
export function extractOutputTokens(msg: unknown): number | undefined {
	if (msg === null || typeof msg !== "object") return undefined;

	const obj = msg as Record<string, unknown>;

	const direct = hasUsage(obj) ? obj.usage.output : undefined;
	if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;

	const nested = obj.message;
	if (nested !== null && typeof nested === "object" && hasUsage(nested)) {
		const value = nested.usage.output;
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	}

	return undefined;
}

const GIT_REFRESH_TOOLS = ["bash", "edit", "write"];

export type EventAdapterOptions = {
	globalConfigPath: string;
	getProjectConfigPath: (cwd: string) => string;
	getThinkingLevel: () => string | undefined;
	onRenderNeeded: () => void;
};

export interface EventAdapter {
	start(ctx: ExtensionContext): Promise<void>;
	shutdown(): void;

	onThinkingLevel(level: string): void;
	onModelSelect(): void;
	onMessageStart(message: { role: string }): void;
	onMessageUpdate(event: {
		message: { role: string };
		assistantMessageEvent: { type: string; delta?: string };
	}): void;
	onMessageEnd(message: { role: string } & Record<string, unknown>): void;
	onToolExecutionStart(event: { toolName: string }): void;
	onToolExecutionEnd(event: { toolName: string }): void;
	onUserBash(): void;

	refresh(): Promise<void>;
	reload(ctx: ExtensionContext): Promise<void>;
	toggle(): Promise<boolean>;

	snapshot(ctx: ExtensionContext): FooterInput;

	get isEnabled(): boolean;
	get config(): ResolvedConfig;
	get loadedPaths(): string[];
	get loadedWarnings(): string[];
	get loadedError(): string | undefined;
}

// ── Session accumulator (private; was the cache in lifecycle + tokens.ts) ──

interface AccumulatorState {
	totals: Totals;
	cost: number;
	entriesLength: number;
}

function createSessionAccumulator() {
	const initial: AccumulatorState = {
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		cost: 0,
		entriesLength: 0,
	};
	let state: AccumulatorState = { ...initial };

	const totalsOf = (entries: readonly { type: string; message?: unknown }[]): Totals => {
		const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string; usage?: AssistantMessage["usage"] } | undefined;
			if (!msg || msg.role !== "assistant") continue;
			const usage = msg.usage;
			if (!usage) continue;
			totals.input += usage.input ?? 0;
			totals.output += usage.output ?? 0;
			totals.cacheRead += usage.cacheRead ?? 0;
			totals.cacheWrite += usage.cacheWrite ?? 0;
		}
		return totals;
	};

	const costOf = (entries: readonly { type: string; message?: unknown }[]): number => {
		let cost = 0;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string; usage?: AssistantMessage["usage"] } | undefined;
			if (!msg || msg.role !== "assistant") continue;
			const total = msg.usage?.cost?.total;
			if (typeof total === "number" && Number.isFinite(total) && total > 0) cost += total;
		}
		return cost;
	};

	return {
		snapshot(entries: readonly { type: string; message?: unknown }[]): {
			totals: Totals;
			cost: number;
		} {
			if (entries.length !== state.entriesLength) {
				state = {
					totals: totalsOf(entries),
					cost: costOf(entries),
					entriesLength: entries.length,
				};
			}
			return { totals: state.totals, cost: state.cost };
		},
		reset(): void {
			state = { ...initial };
		},
	};
}

// ── Factory ─────────────────────────────────────────────────────

export function createEventAdapter(options: EventAdapterOptions): EventAdapter {
	const { globalConfigPath, getProjectConfigPath, getThinkingLevel, onRenderNeeded } = options;

	let config: ResolvedConfig = defaultConfig;
	let loaded = {
		config,
		loadedPaths: [] as string[],
		warnings: [] as string[],
		error: undefined as string | undefined,
	};
	let thinkingLevel: string | undefined;
	let git: GitStateHandle | undefined;
	let toks: ToksActivityHandle = createToksActivity({ onRenderNeeded });
	let enabled = true;
	let cwd = "";
	let directory = "";
	const accumulator = createSessionAccumulator();

	function triggerRender(): void {
		onRenderNeeded();
	}

	function resetToks(): void {
		toks.shutdown();
		toks = createToksActivity({ onRenderNeeded });
	}

	function createGitHandle(cwdForGit: string): void {
		git = createGitState({
			cwd: cwdForGit,
			debounceMs: config.gitRefreshDebounceMs,
			enabled: config.showGit,
			onChange: () => onRenderNeeded(),
		});
	}

	return {
		async start(ctx) {
			accumulator.reset();
			cwd = ctx.cwd;
			directory = path.basename(ctx.cwd);
			loaded = loadFooterConfig(globalConfigPath, getProjectConfigPath(ctx.cwd));
			config = loaded.config;
			thinkingLevel = normalizeThinkingLevel(getThinkingLevel());
			enabled = config.enabled;

			if (enabled) {
				createGitHandle(ctx.cwd);
				await git!.refresh();
			}
		},

		shutdown() {
			git?.clear();
			git = undefined;
			accumulator.reset();
			toks.shutdown();
		},

		onThinkingLevel(level) {
			thinkingLevel = normalizeThinkingLevel(level);
			triggerRender();
		},

		onModelSelect() {
			triggerRender();
		},

		onMessageStart(message) {
			if (message.role === "assistant") toks.onMessageStart();
		},

		onMessageUpdate(event) {
			if (event.message.role !== "assistant") return;
			const stream = event.assistantMessageEvent;
			const delta = stream.delta;
			const outputTokens = extractOutputTokens(event.message);
			toks.onMessageUpdate(stream.type, delta, outputTokens);
		},

		onMessageEnd(message) {
			if (message.role !== "assistant") return;
			const outputTokens = extractOutputTokens(message);
			toks.onMessageEnd(outputTokens);
		},

		onToolExecutionStart(event) {
			toks.onToolStart(event.toolName);
		},

		onToolExecutionEnd(event) {
			toks.onToolEnd();
			if (GIT_REFRESH_TOOLS.includes(event.toolName)) git?.schedule();
		},

		onUserBash() {
			git?.schedule();
		},

		async refresh() {
			await git?.refresh();
		},

		async reload(ctx) {
			accumulator.reset();
			resetToks();
			loaded = loadFooterConfig(globalConfigPath, getProjectConfigPath(ctx.cwd));
			config = loaded.config;
			enabled = config.enabled;

			git?.clear();
			git = undefined;

			if (enabled) {
				createGitHandle(cwd);
				await git!.refresh();
			}
			triggerRender();
		},

		async toggle() {
			accumulator.reset();
			resetToks();
			enabled = !enabled;
			if (!enabled) {
				git?.clear();
				git = undefined;
			} else {
				thinkingLevel = normalizeThinkingLevel(getThinkingLevel());
				createGitHandle(cwd);
				await git!.refresh();
			}
			triggerRender();
			return enabled;
		},

		snapshot(ctx) {
			const entries = ctx.sessionManager.getEntries();
			const { totals, cost } = accumulator.snapshot(entries);
			return {
				modelId: ctx.model?.id ?? "no-model",
				thinkingLevel,
				directory: directory || path.basename(ctx.cwd),
				gitBranch: git?.state.branch,
				gitDirtyCount: git?.state.dirtyCount ?? 0,
				contextUsed: ctx.getContextUsage?.()?.tokens ?? 0,
				contextMax: ctx.model?.contextWindow,
				totals,
				sessionCost: cost,
				toksState: toks.getState(),
				config,
			};
		},

		get isEnabled() {
			return enabled;
		},
		get config() {
			return config;
		},
		get loadedPaths() {
			return loaded.loadedPaths;
		},
		get loadedWarnings() {
			return loaded.warnings;
		},
		get loadedError() {
			return loaded.error;
		},
	};
}
