import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";

import { loadFooterConfig } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { renderFooter, type FooterInput } from "./renderer.js";
import { createGitState, type GitStateHandle } from "./git.js";
import { accumulateTotals } from "./tokens.js";
import { normalizeThinkingLevel } from "./utils.js";

export default function (pi: ExtensionAPI) {
	// ── State (closure captures, no module-level globals) ──────────
	let config: ResolvedConfig;
	let loadedConfig: ReturnType<typeof loadFooterConfig>;
	let thinkingLevel: string | undefined;
	let git: GitStateHandle | undefined;
	let footerEnabled = true;
	let requestRender: () => void = () => {};

	const globalConfigPath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"clean-footer.json",
	);

	// ── Commands ───────────────────────────────────────────────────

	pi.registerCommand("footer", {
		description: "Toggle, refresh, or configure the clean footer",
		handler: async (args, ctx) => {
			const command = args.trim();

			if (command === "refresh") {
				await git?.refresh();
				if (ctx.hasUI) ctx.ui.notify("Footer refreshed", "info");
				return;
			}

			if (command === "reload") {
				loadedConfig = loadFooterConfig(
					globalConfigPath,
					path.join(ctx.cwd, ".pi", "clean-footer.json"),
				);
				config = loadedConfig.config;
				footerEnabled = config.enabled;
				if (ctx.hasUI && footerEnabled) installFooter(ctx);
				if (ctx.hasUI && !footerEnabled) ctx.ui.setFooter(undefined);
				requestRender();
				notifyConfigStatus(ctx);
				return;
			}

			if (command === "config") {
				showConfig(ctx);
				return;
			}

			// toggle
			footerEnabled = !footerEnabled;
			if (!ctx.hasUI) return;

			if (footerEnabled) {
				thinkingLevel = normalizeThinkingLevel(pi.getThinkingLevel?.());
				installFooter(ctx);
				await git?.refresh();
				ctx.ui.notify("Clean footer enabled", "info");
			} else {
				git?.clear();
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});

	// ── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		loadedConfig = loadFooterConfig(
			globalConfigPath,
			path.join(ctx.cwd, ".pi", "clean-footer.json"),
		);
		config = loadedConfig.config;
		thinkingLevel = normalizeThinkingLevel(pi.getThinkingLevel?.());
		footerEnabled = config.enabled;
		if (!ctx.hasUI || !footerEnabled) return;

		installFooter(ctx);
		git = createGitState({
			cwd: ctx.cwd,
			debounceMs: config.gitRefreshDebounceMs,
			enabled: config.showGit,
			onChange: () => requestRender(),
		});
		await git.refresh();
		if (loadedConfig.error)
			ctx.ui.notify(`Config error: ${loadedConfig.error}`, "error");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		git?.clear();
		requestRender = () => {};
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});

	pi.on("thinking_level_select", (event) => {
		thinkingLevel = normalizeThinkingLevel(event.level);
		requestRender();
	});

	pi.on("model_select", () => {
		requestRender();
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") requestRender();
	});

	pi.on("tool_execution_end", (event) => {
		if (["bash", "edit", "write"].includes(event.toolName))
			git?.schedule();
		requestRender();
	});

	pi.on("user_bash", () => {
		git?.schedule();
	});

	// ── Lifecycle ──────────────────────────────────────────────────

	function installFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme) => {
			requestRender = () => tui.requestRender();

			return {
				invalidate() {},
				render(width: number): string[] {
					const input: FooterInput = {
						modelId: ctx.model?.id ?? "no-model",
						thinkingLevel,
						directory: path.basename(ctx.cwd),
						gitBranch: git?.state.branch,
						gitDirtyCount: git?.state.dirtyCount ?? 0,
						contextUsed: ctx.getContextUsage?.()?.tokens ?? 0,
						contextMax: ctx.model?.contextWindow,
						totals: accumulateTotals(ctx.sessionManager.getBranch()),
						config,
					};
					return renderFooter(input, theme, width);
				},
			};
		});
	}

	// ── Config helpers ─────────────────────────────────────────────

	function notifyConfigStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (loadedConfig.error) {
			ctx.ui.notify(
				`Clean footer config error: ${loadedConfig.error}`,
				"error",
			);
		} else {
			ctx.ui.notify("Clean footer config loaded", "info");
		}
	}

	function showConfig(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const loaded = loadedConfig.loadedPaths.length
			? loadedConfig.loadedPaths.join("\n")
			: "none";
		const projectPath = path.join(ctx.cwd, ".pi", "clean-footer.json");
		ctx.ui.notify(
			[
				"Clean footer config",
				`global: ${globalConfigPath}`,
				`project: ${projectPath}`,
				`loaded:\n${loaded}`,
				loadedConfig.error
					? `error: ${loadedConfig.error}`
					: "error: none",
				`resolved: ${JSON.stringify(config)}`,
			].join("\n"),
			"info",
		);
	}

}
