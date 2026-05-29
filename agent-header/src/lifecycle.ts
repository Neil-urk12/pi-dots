import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";

import { defaultConfig, loadHeaderConfig, type ResolvedConfig } from "./config.js";
import type { HeaderInput } from "./types.js";
import { createGitState, type GitStateHandle } from "./git.js";

type LifecycleOptions = {
	globalConfigPath: string;
	getProjectConfigPath: (cwd: string) => string;
	onRenderNeeded: () => void;
};

export class HeaderLifecycle {
	#config: ResolvedConfig;
	#loadedConfig: ReturnType<typeof loadHeaderConfig>;
	#git: GitStateHandle | undefined;
	#enabled: boolean;
	#cwd: string;
	#globalConfigPath: string;
	#getProjectConfigPath: (cwd: string) => string;
	#onRenderNeeded: () => void;

	constructor(opts: LifecycleOptions) {
		this.#globalConfigPath = opts.globalConfigPath;
		this.#getProjectConfigPath = opts.getProjectConfigPath;
		this.#onRenderNeeded = opts.onRenderNeeded;
		this.#config = defaultConfig;
		this.#loadedConfig = { config: this.#config, loadedPaths: [], warnings: [] };
		this.#enabled = true;
		this.#cwd = "";
	}

	// ── Lifecycle ──────────────────────────────────────────────────

	async start(ctx: ExtensionContext): Promise<void> {
		this.#cwd = ctx.cwd;
		this.#loadedConfig = loadHeaderConfig(
			this.#globalConfigPath,
			this.#getProjectConfigPath(ctx.cwd),
		);
		this.#config = this.#loadedConfig.config;
		this.#enabled = this.#config.enabled;

		if (this.#enabled) {
			this.#createGit(ctx.cwd);
			await this.#git?.refresh();
		}
	}

	shutdown(): void {
		this.#git?.clear();
		this.#git = undefined;
	}

	#createGit(cwd: string): void {
		this.#git = createGitState({
			cwd,
			enabled: this.#config.showGit,
			onChange: () => this.#onRenderNeeded(),
		});
	}

	// ── Events ─────────────────────────────────────────────────────

	onModelSelect(): void {
		this.#onRenderNeeded();
	}

	onToolExecutionEnd(toolName: string): void {
		if (["bash", "edit", "write"].includes(toolName)) {
			this.#git?.schedule();
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
		this.#loadedConfig = loadHeaderConfig(
			this.#globalConfigPath,
			this.#getProjectConfigPath(ctx.cwd),
		);
		this.#config = this.#loadedConfig.config;
		this.#enabled = this.#config.enabled;

		this.#git?.clear();
		this.#git = undefined;

		if (this.#enabled) {
			this.#createGit(this.#cwd);
			await this.#git?.refresh();
		}

		this.#onRenderNeeded();
	}

	async toggle(): Promise<boolean> {
		this.#enabled = !this.#enabled;
		if (!this.#enabled) {
			this.#git?.clear();
			this.#git = undefined;
		} else {
			this.#createGit(this.#cwd);
			await this.#git?.refresh();
		}
		this.#onRenderNeeded();
		return this.#enabled;
	}

	// ── Query ──────────────────────────────────────────────────────

	getInput(ctx: ExtensionContext): HeaderInput {
		return {
			name: this.#config.name,
			gitBranch: this.#config.showGit ? this.#git?.state.branch : undefined,
			modelId: this.#config.showModel ? (ctx.model?.id ?? "no-model") : "",
			directory: this.#config.showDirectory ? path.basename(ctx.cwd) : "",
			config: this.#config,
		};
	}

	// ── Getters ────────────────────────────────────────────────────

	get isEnabled(): boolean {
		return this.#enabled;
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

