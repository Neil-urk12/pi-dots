import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { defaultConfig, loadFooterConfig, type ResolvedConfig } from "./config.js";
import type { FooterInput, Totals, ToksDisplayState } from "./types.js";
import { createGitState, type GitStateHandle } from "./git.js";
import { accumulateTotals } from "./tokens.js";
import { normalizeThinkingLevel } from "./utils.js";
import { createToksActivity, type ToksActivityHandle } from "./toksActivity.js";


type LifecycleOptions = {
	globalConfigPath: string;
	getProjectConfigPath: (cwd: string) => string;
	getThinkingLevel: () => string | undefined;
	onRenderNeeded: () => void;
};

export class FooterLifecycle {
	#config: ResolvedConfig;
	#loadedConfig: ReturnType<typeof loadFooterConfig>;
	#thinkingLevel: string | undefined;
	#git: GitStateHandle | undefined;
	#toks: ToksActivityHandle;
	#footerEnabled: boolean;
	#cwd: string;
	#globalConfigPath: string;
	#getProjectConfigPath: (cwd: string) => string;
	#getThinkingLevel: () => string | undefined;
	#onRenderNeeded: () => void;
	#cachedTotals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	#cachedBranchLength: number = 0;

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
		this.#toks = createToksActivity({ onRenderNeeded: () => this.#onRenderNeeded() });
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
			this.#toks.onMessageStart();
		}
	}

	onToolExecutionStart(toolName: string): void {
		this.#toks.onToolStart(toolName);
	}

	onToolExecutionUpdate(_toolName: string): void {
		// Activity timer already handles dot cycling; nothing to do here.
	}

	onToolExecutionEnd(toolName: string): void {
		this.#toks.onToolEnd();
		// Schedule git refresh for relevant tools
		if (["bash", "edit", "write"].includes(toolName)) {
			this.#git?.schedule();
		}
	}

	onMessageUpdate(eventType: string, delta?: string, outputTokens?: number): void {
		this.#toks.onMessageUpdate(eventType, delta, outputTokens);
	}

	onMessageEnd(role: string, outputTokens?: number): void {
		if (role === "assistant") {
			this.#toks.onMessageEnd(outputTokens);
		}
	}

	/**
	 * Pre-wired for a future `message_abort` event in the pi extension API.
	 * No such event exists yet — this method is not currently reachable.
	 */
	onMessageAbort(): void {
		this.#toks.onMessageAbort();
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
			toksState: this.#toks.getState(),
			config: this.#config,
		};
	}

	#resetState(): void {
		this.#cachedTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		this.#cachedBranchLength = 0;
		this.#toks.shutdown();
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
