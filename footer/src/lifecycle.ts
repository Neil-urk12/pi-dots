import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { defaultConfig, loadFooterConfig, type ResolvedConfig } from "./config.js";
import type { FooterInput, Totals, ToksDisplayState } from "./types.js";
import { createGitState, type GitStateHandle } from "./git.js";
import { accumulateTotals } from "./tokens.js";
import { normalizeThinkingLevel } from "./utils.js";
import { normalizeToolLabel } from "./tokLabels.js";

import { estimateTokens } from "./tokenEstimate.js";

// ── Activity animation constants ─────────────────────────────
const ACTIVITY_CADENCE_MS = 300;
const FINAL_RATE_HIDE_MS = 5000;
const ACTIVITY_DOT_FRAMES = [".  ", ".. ", "..."];


type LifecycleOptions = {
	globalConfigPath: string;
	getProjectConfigPath: (cwd: string) => string;
	getThinkingLevel: () => string | undefined;
	onRenderNeeded: () => void;
};

type ToksSample = {
	startTime: number;
	estimatedTokens: number;
	hasObservedOutput: boolean;
	displayState: ToksDisplayState;
};

export class FooterLifecycle {
	#config: ResolvedConfig;
	#loadedConfig: ReturnType<typeof loadFooterConfig>;
	#thinkingLevel: string | undefined;
	#git: GitStateHandle | undefined;
	#footerEnabled: boolean;
	#cwd: string;
	#globalConfigPath: string;
	#getProjectConfigPath: (cwd: string) => string;
	#getThinkingLevel: () => string | undefined;
	#onRenderNeeded: () => void;
	#cachedTotals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	#cachedBranchLength: number = 0;
	#toksSample: ToksSample | undefined = undefined;
	#activeToolCount: number = 0;
	#latestToolLabel: string = "";
	#activityDotIndex: number = 0;
	#activityTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	#endsAtTimer: ReturnType<typeof setTimeout> | undefined = undefined;

	constructor(opts: LifecycleOptions) {
		this.#globalConfigPath = opts.globalConfigPath;
		this.#getProjectConfigPath = opts.getProjectConfigPath;
		this.#getThinkingLevel = opts.getThinkingLevel;
		this.#onRenderNeeded = opts.onRenderNeeded;
		this.#config = defaultConfig;
		this.#loadedConfig = { config: this.#config, loadedPaths: [], warnings: [] };
		this.#thinkingLevel = undefined;
		this.#git = undefined;
		this.#footerEnabled = true;
		this.#cwd = "";
	}

	// ── Lifecycle ──────────────────────────────────────────────────

	async start(ctx: ExtensionContext): Promise<void> {
		this.#cachedTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.#cachedBranchLength = 0;
		this.#cwd = ctx.cwd;
		this.#loadedConfig = loadFooterConfig(
			this.#globalConfigPath,
			this.#getProjectConfigPath(ctx.cwd),
		);
		this.#config = this.#loadedConfig.config;
		this.#thinkingLevel = normalizeThinkingLevel(this.#getThinkingLevel());
		this.#footerEnabled = this.#config.enabled;

		if (this.#footerEnabled) {
			this.#createGit(ctx.cwd);
			await this.#git!.refresh();
		}
	}

shutdown(): void {
		this.#git?.clear();
		this.#git = undefined;
		this.#resetState();
	}

	#createGit(cwd: string): void {
		this.#git = createGitState({
			cwd,
			debounceMs: this.#config.gitRefreshDebounceMs,
			enabled: this.#config.showGit,
			onChange: () => this.#onRenderNeeded(),
		});
	}

	// ── Events ─────────────────────────────────────────────────────

	onThinkingLevel(level: string): void {
		this.#thinkingLevel = normalizeThinkingLevel(level);
		this.#onRenderNeeded();
	}

	onModelSelect(): void {
		this.#onRenderNeeded();
	}

	onMessageStart(role: string): void {
		if (role === "assistant") {
			this.#stopEndsAtTimer();
			this.#toksSample = {
				startTime: Date.now(),
				estimatedTokens: 0,
				hasObservedOutput: false,
				displayState: { state: "pending" },
			};
			this.#onRenderNeeded();
		}
	}

	onToolExecutionStart(toolName: string): void {
		this.#activeToolCount++;
		this.#latestToolLabel = normalizeToolLabel(toolName) + "...";
		this.#activityDotIndex = 0;
		this.#startActivityTimer();
		this.#onRenderNeeded();
	}

	onToolExecutionUpdate(_toolName: string): void {
		// Activity timer already handles dot cycling; nothing to do here.
	}

	onToolExecutionEnd(toolName: string): void {
		this.#activeToolCount = Math.max(0, this.#activeToolCount - 1);
		if (this.#activeToolCount === 0) {
		this.#stopActivityTimer();
		}
		// Still schedule git refresh for relevant tools
		if (["bash", "edit", "write"].includes(toolName)) {
			this.#git?.schedule();
		}
		this.#onRenderNeeded();
	}

	onMessageUpdate(eventType: string, delta?: string, outputTokens?: number): void {
		if (!this.#toksSample || !delta) return;
		if (eventType !== "text_delta" && eventType !== "thinking_delta" && eventType !== "toolcall_delta") return;

		this.#toksSample.estimatedTokens += estimateTokens(delta);
		this.#toksSample.hasObservedOutput = true;

		const elapsed = (Date.now() - this.#toksSample.startTime) / 1000;
		if (elapsed > 0) {
			const currentTokens = (outputTokens && outputTokens > 0) ? outputTokens : this.#toksSample.estimatedTokens;
			this.#toksSample.displayState = {
				state: "rate",
				value: currentTokens / elapsed,
				approximate: !(outputTokens && outputTokens > 0),
			};
		}

		this.#onRenderNeeded();
	}

	onMessageEnd(role: string, outputTokens?: number): void {
		if (role === "assistant") {
			this.#activeToolCount = 0;
			this.#stopActivityTimer();
			if (this.#toksSample) {
				const elapsed = (Date.now() - this.#toksSample.startTime) / 1000;
				if (outputTokens && outputTokens > 0 && elapsed > 0) {
					this.#toksSample.displayState = {
						state: "rate",
						value: outputTokens / elapsed,
						approximate: false,
					};
					this.#scheduleEndsAt();
				} else if (this.#toksSample.hasObservedOutput && elapsed > 0) {
					this.#toksSample.displayState = {
						state: "rate",
						value: this.#toksSample.estimatedTokens / elapsed,
						approximate: true,
					};
					this.#scheduleEndsAt();
				} else {
					this.#toksSample = undefined;
				}
			}
			this.#onRenderNeeded();
		}
	}

	/**
	 * Pre-wired for a future `message_abort` event in the pi extension API.
	 * No such event exists yet — this method is not currently reachable.
	 */
	onMessageAbort(): void {
		if (this.#toksSample) {
			if (this.#toksSample.hasObservedOutput) {
				const elapsed = (Date.now() - this.#toksSample.startTime) / 1000;
				if (elapsed > 0) {
					this.#toksSample.displayState = {
						state: "rate",
						value: this.#toksSample.estimatedTokens / elapsed,
						approximate: true,
					};
				}
			} else {
				this.#toksSample = undefined;
			}
		}
		this.#onRenderNeeded();
	}


	#resetState(): void {
		this.#cachedTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.#cachedBranchLength = 0;
		this.#toksSample = undefined;
		this.#activeToolCount = 0;
		this.#latestToolLabel = "";
		this.#activityDotIndex = 0;
		this.#stopActivityTimer();
		this.#stopEndsAtTimer();
	}

	#startActivityTimer(): void {
		this.#stopActivityTimer();
		this.#activityTimer = setInterval(() => {
			this.#activityDotIndex = (this.#activityDotIndex + 1) % ACTIVITY_DOT_FRAMES.length;
			this.#onRenderNeeded();
		}, ACTIVITY_CADENCE_MS);
	}

	#stopActivityTimer(): void {
		if (this.#activityTimer) {
			clearInterval(this.#activityTimer);
			this.#activityTimer = undefined;
		}
	}

	#scheduleEndsAt(): void {
		this.#stopEndsAtTimer();
		this.#endsAtTimer = setTimeout(() => {
			this.#endsAtTimer = undefined;
			if (this.#toksSample) {
				this.#toksSample = undefined;
				this.#onRenderNeeded();
			}
		}, FINAL_RATE_HIDE_MS);
	}

	#stopEndsAtTimer(): void {
		if (this.#endsAtTimer) {
			clearTimeout(this.#endsAtTimer);
			this.#endsAtTimer = undefined;
		}
	}

	onUserBash(): void {
		this.#git?.schedule();
	}

	// ── Commands ───────────────────────────────────────────────────

	async refresh(): Promise<void> {
		await this.#git?.refresh();
	}

async reload(ctx: ExtensionContext): Promise<void> {
		this.#resetState();
		this.#loadedConfig = loadFooterConfig(
			this.#globalConfigPath,
			this.#getProjectConfigPath(ctx.cwd),
		);
		this.#config = this.#loadedConfig.config;
		this.#footerEnabled = this.#config.enabled;

		this.#git?.clear();
		this.#git = undefined;

		if (this.#footerEnabled) {
			this.#createGit(this.#cwd);
			await this.#git!.refresh();
		}

		this.#onRenderNeeded();
	}

async toggle(): Promise<boolean> {
		this.#resetState();
		this.#footerEnabled = !this.#footerEnabled;
		if (!this.#footerEnabled) {
			this.#git?.clear();
			this.#git = undefined;
		} else {
			this.#thinkingLevel = normalizeThinkingLevel(this.#getThinkingLevel());
			this.#createGit(this.#cwd);
			await this.#git!.refresh();
		}
		this.#onRenderNeeded();
		return this.#footerEnabled;
	}

	// ── Query ──────────────────────────────────────────────────────

	getFooterInput(ctx: ExtensionContext): FooterInput {
		const branch = ctx.sessionManager.getBranch();
		if (branch.length !== this.#cachedBranchLength) {
			this.#cachedTotals = accumulateTotals(branch);
			this.#cachedBranchLength = branch.length;
		}
		return {
			modelId: ctx.model?.id ?? "no-model",
			thinkingLevel: this.#thinkingLevel,
			directory: path.basename(ctx.cwd),
			gitBranch: this.#git?.state.branch,
			gitDirtyCount: this.#git?.state.dirtyCount ?? 0,
			contextUsed: ctx.getContextUsage?.()?.tokens ?? 0,
			contextMax: ctx.model?.contextWindow,
			totals: this.#cachedTotals,
			toksState: this.#computeToksState(),
			config: this.#config,
		};
	}

	#computeToksState(): ToksDisplayState {
		// Tool activity takes priority
		if (this.#activeToolCount > 0) {
			return { state: "activity", label: this.#latestToolLabel };
		}
		// Fall back to toksSample state
		return this.#toksSample?.displayState ?? { state: "hidden" };
	}

	// ── Getters ────────────────────────────────────────────────────

	get isEnabled(): boolean {
		return this.#footerEnabled;
	}

	get loadedError(): string | undefined {
		return this.#loadedConfig.error;
	}

	get loadedWarnings(): string[] {
		return this.#loadedConfig.warnings;
	}

	get loadedPaths(): string[] {
		return this.#loadedConfig.loadedPaths;
	}

	get config(): ResolvedConfig {
		return this.#config;
	}
}
