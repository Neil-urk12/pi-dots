import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";

import { FooterLifecycle } from "./lifecycle.js";
import { renderFooter } from "./renderer.js";

export type { ColorFn, FooterInput, Totals, Theme } from "./types.js";

export default function (pi: ExtensionAPI) {
	const globalConfigPath = path.join(
		os.homedir(),
		".pi",
		"agent",
		"clean-footer.json",
	);

	const getProjectConfigPath = (cwd: string) =>
		path.join(cwd, ".pi", "clean-footer.json");

	let requestRender: () => void = () => {};

	const lifecycle = new FooterLifecycle({
		globalConfigPath,
		getProjectConfigPath,
		getThinkingLevel: () => pi.getThinkingLevel?.(),
		onRenderNeeded: () => requestRender(),
	});

	// ── Commands ───────────────────────────────────────────────────

	pi.registerCommand("footer", {
		description: "Toggle, refresh, or configure the clean footer",
		handler: async (args, ctx) => {
			const command = args.trim();

			if (command === "refresh") {
				await lifecycle.refresh();
				if (ctx.hasUI) ctx.ui.notify("Footer refreshed", "info");
				return;
			}

			if (command === "reload") {
				await lifecycle.reload(ctx);
				if (ctx.hasUI && lifecycle.isEnabled) installFooter(ctx);
				if (ctx.hasUI && !lifecycle.isEnabled) ctx.ui.setFooter(undefined);
				requestRender();
				notifyConfigStatus(ctx);
				return;
			}

			if (command === "config") {
				showConfig(ctx);
				return;
			}

			// toggle
			const enabled = await lifecycle.toggle();
			if (!ctx.hasUI) return;

			if (enabled) {
				installFooter(ctx);
				ctx.ui.notify("Clean footer enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});

	// ── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await lifecycle.start(ctx);
		if (ctx.hasUI && lifecycle.loadedError && lifecycle.isEnabled)
			ctx.ui.notify(`Config error: ${lifecycle.loadedError}`, "error");
		if (ctx.hasUI && lifecycle.isEnabled) installFooter(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		lifecycle.shutdown();
		requestRender = () => {};
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});

	pi.on("thinking_level_select", (event) => {
		lifecycle.onThinkingLevel(event.level);
	});

	pi.on("model_select", () => {
		lifecycle.onModelSelect();
	});

	pi.on("message_end", (event) => {
		lifecycle.onMessageEnd(event.message.role);
	});

	pi.on("tool_execution_end", (event) => {
		lifecycle.onToolEnd(event.toolName);
	});

	pi.on("user_bash", () => {
		lifecycle.onUserBash();
	});

	// ── UI helpers ──────────────────────────────────────────────────

	function installFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((_tui, _theme) => {
			requestRender = () => _tui.requestRender();

			return {
				invalidate() {},
				render(width: number): string[] {
					const input = lifecycle.getFooterInput(ctx);
					return renderFooter(input, _theme, width);
				},
			};
		});
	}

	function notifyConfigStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (lifecycle.loadedError) {
			ctx.ui.notify(
				`Clean footer config error: ${lifecycle.loadedError}`,
				"error",
			);
		} else if (lifecycle.loadedWarnings.length > 0) {
			ctx.ui.notify(
				`Clean footer config loaded with warnings: ${lifecycle.loadedWarnings.join("; ")}`,
				"warning",
			);
		} else {
			ctx.ui.notify("Clean footer config loaded", "info");
	}
	}

	function showConfig(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const loaded = lifecycle.loadedPaths.length
			? lifecycle.loadedPaths.join("\n")
			: "none";
		const warnings = lifecycle.loadedWarnings.length
			? lifecycle.loadedWarnings.join("\n")
			: "none";
		const projectPath = getProjectConfigPath(ctx.cwd);
		ctx.ui.notify(
			[
				"Clean footer config",
				`global: ${globalConfigPath}`,
				`project: ${projectPath}`,
				`loaded:\n${loaded}`,
				lifecycle.loadedError
					? `error: ${lifecycle.loadedError}`
					: "error: none",
				`warnings:\n${warnings}`,
				`preset: ${lifecycle.config.preset}`,
				`resolved: ${JSON.stringify(lifecycle.config)}`,
			].join("\n"),
			"info",
		);
	}
}
