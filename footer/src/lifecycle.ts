import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { defaultConfig, loadFooterConfig, type ResolvedConfig } from "./config.js";
import type { FooterInput } from "./types.js";
import { createGitState, type GitStateHandle } from "./git.js";
import { accumulateTotals } from "./tokens.js";
import { normalizeThinkingLevel } from "./utils.js";

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
	#footerEnabled: boolean;
	#cwd: string;
	#globalConfigPath: string;
	#getProjectConfigPath: (cwd: string) => string;
	#getThinkingLevel: () => string | undefined;
	#onRenderNeeded: () => void;

	constructor(opts: LifecycleOptions) {
		this.#globalConfigPath = opts.globalConfigPath;
		this.#getProjectConfigPath = opts.getProjectConfigPath;
		this.#getThinkingLevel = opts.getThinkingLevel;
		this.#onRenderNeeded = opts.onRenderNeeded;
		this.#config = defaultConfig;
		this.#loadedConfig = { config: this.#config, loadedPaths: [] };
		this.#thinkingLevel = undefined;
		this.#git = undefined;
		this.#footerEnabled = true;
		this.#cwd = "";
	}

	// ── Lifecycle ──────────────────────────────────────────────────

	async start(ctx: ExtensionContext): Promise<void> {
		this.#cwd = ctx.cwd;
		this.#loadedConfig = loadFooterConfig(
			this.#globalConfigPath,
			this.#getProjectConfigPath(ctx.cwd),
		);
		this.#config = this.#loadedConfig.config;
		this.#thinkingLevel = normalizeThinkingLevel(
			this.#getThinkingLevel(),
		);
		this.#footerEnabled = this.#config.enabled;

		if (this.#footerEnabled) {
			this.#git = createGitState({
				cwd: ctx.cwd,
				debounceMs: this.#config.gitRefreshDebounceMs,
				enabled: this.#config.showGit,
				onChange: () => this.#onRenderNeeded(),
			});
			await this.#git.refresh();
		}
	}

	shutdown(): void {
		this.#git?.clear();
		this.#git = undefined;
	}

	// ── Events ─────────────────────────────────────────────────────

	onThinkingLevel(level: string): void {
		this.#thinkingLevel = normalizeThinkingLevel(level);
		this.#onRenderNeeded();
	}

	onModelSelect(): void {
		this.#onRenderNeeded();
	}

	onMessageEnd(role: string): void {
		if (role === "assistant") this.#onRenderNeeded();
	}

	onToolEnd(toolName: string): void {
		if (["bash", "edit", "write"].includes(toolName)) {
			this.#git?.schedule();
		}
		this.#onRenderNeeded();
	}

	onUserBash(): void {
		this.#git?.schedule();
	}

	// ── Commands ───────────────────────────────────────────────────

	async refresh(): Promise<void> {
		await this.#git?.refresh();
	}

	async reload(ctx: ExtensionContext): Promise<void> {
		this.#loadedConfig = loadFooterConfig(
			this.#globalConfigPath,
			this.#getProjectConfigPath(ctx.cwd),
		);
		this.#config = this.#loadedConfig.config;
		this.#footerEnabled = this.#config.enabled;

		this.#git?.clear();
		this.#git = undefined;

		if (this.#footerEnabled) {
			this.#git = createGitState({
				cwd: this.#cwd,
				debounceMs: this.#config.gitRefreshDebounceMs,
				enabled: this.#config.showGit,
				onChange: () => this.#onRenderNeeded(),
			});
			await this.#git.refresh();
		}

		this.#onRenderNeeded();
	}

	async toggle(): Promise<boolean> {
		this.#footerEnabled = !this.#footerEnabled;
		if (!this.#footerEnabled) {
			this.#git?.clear();
			this.#git = undefined;
		} else {
			this.#thinkingLevel = normalizeThinkingLevel(this.#getThinkingLevel());
			this.#git = createGitState({
				cwd: this.#cwd,
				debounceMs: this.#config.gitRefreshDebounceMs,
				enabled: this.#config.showGit,
				onChange: () => this.#onRenderNeeded(),
			});
			await this.#git.refresh();
		}
		this.#onRenderNeeded();
		return this.#footerEnabled;
	}

	// ── Query ──────────────────────────────────────────────────────

	getFooterInput(ctx: ExtensionContext): FooterInput {
		return {
			modelId: ctx.model?.id ?? "no-model",
			thinkingLevel: this.#thinkingLevel,
			directory: path.basename(ctx.cwd),
			gitBranch: this.#git?.state.branch,
			gitDirtyCount: this.#git?.state.dirtyCount ?? 0,
			contextUsed: ctx.getContextUsage?.()?.tokens ?? 0,
			contextMax: ctx.model?.contextWindow,
			totals: accumulateTotals(ctx.sessionManager.getBranch()),
			config: this.#config,
		};
	}

	// ── Getters ────────────────────────────────────────────────────

	get isEnabled(): boolean {
		return this.#footerEnabled;
	}

	get loadedError(): string | undefined {
		return this.#loadedConfig.error;
	}

	get loadedPaths(): string[] {
		return this.#loadedConfig.loadedPaths;
	}

	get config(): ResolvedConfig {
		return this.#config;
	}
}
