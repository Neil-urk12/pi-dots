import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";

import { createEventAdapter, type EventAdapter } from "./eventAdapter.js";
import { renderFooter } from "./renderer.js";

export type { ColorFn, FooterInput, Totals, Theme } from "./types.js";

export default function (pi: ExtensionAPI) {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "clean-footer.json");
	const getProjectConfigPath = (cwd: string) => path.join(cwd, ".pi", "clean-footer.json");

	let requestRender: () => void = () => {};
	const adapter: EventAdapter = createEventAdapter({
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
				await adapter.refresh();
				if (ctx.hasUI) ctx.ui.notify("Footer refreshed", "info");
				return;
			}

			if (command === "reload") {
				await adapter.reload(ctx);
				if (ctx.hasUI && adapter.isEnabled) installFooter(ctx);
				if (ctx.hasUI && !adapter.isEnabled) ctx.ui.setFooter(undefined);
				requestRender();
				notifyConfigStatus(ctx);
				return;
			}

			if (command === "config") {
				showConfig(ctx);
				return;
			}

			const enabled = await adapter.toggle();
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
		await adapter.start(ctx);
		if (ctx.hasUI && adapter.loadedError && adapter.isEnabled)
			ctx.ui.notify(`Config error: ${adapter.loadedError}`, "error");
		if (ctx.hasUI && adapter.isEnabled) installFooter(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		adapter.shutdown();
		requestRender = () => {};
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});

	pi.on("thinking_level_select", (event) => {
		adapter.onThinkingLevel(event.level);
	});

	pi.on("model_select", () => {
		adapter.onModelSelect();
	});

	pi.on("message_start", (event) => {
		adapter.onMessageStart(event.message);
	});

	pi.on("message_end", (event) => {
		adapter.onMessageEnd(event.message);
	});

	pi.on("message_update", (event) => {
		adapter.onMessageUpdate(event);
	});

	pi.on("tool_execution_start", (event) => {
		adapter.onToolExecutionStart(event);
	});

	pi.on("tool_execution_end", (event) => {
		adapter.onToolExecutionEnd(event);
	});

	pi.on("user_bash", () => {
		adapter.onUserBash();
	});

	// ── UI helpers ─────────────────────────────────────────────────

	function installFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme) => {
			requestRender = () => tui.requestRender();

			return {
				invalidate() {},
				render(width: number): string[] {
					try {
						const input = adapter.snapshot(ctx);
						return renderFooter(input, theme, width);
					} catch (err) {
						console.error("[clean-footer] render failed:", err instanceof Error ? err.message : err);
						return [];
					}
				},
			};
		});
	}

	function notifyConfigStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (adapter.loadedError) {
			ctx.ui.notify(`Clean footer config error: ${adapter.loadedError}`, "error");
		} else if (adapter.loadedWarnings.length > 0) {
			ctx.ui.notify(
				`Clean footer config loaded with warnings: ${adapter.loadedWarnings.join("; ")}`,
				"warning",
			);
		} else {
			ctx.ui.notify("Clean footer config loaded", "info");
		}
	}

	function showConfig(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const loaded = adapter.loadedPaths.length ? adapter.loadedPaths.join("\n") : "none";
		const warnings = adapter.loadedWarnings.length ? adapter.loadedWarnings.join("\n") : "none";
		const projectPath = getProjectConfigPath(ctx.cwd);
		ctx.ui.notify(
			[
				"Clean footer config",
				`global: ${globalConfigPath}`,
				`project: ${projectPath}`,
				`loaded:\n${loaded}`,
				adapter.loadedError ? `error: ${adapter.loadedError}` : "error: none",
				`warnings:\n${warnings}`,
				`preset: ${adapter.config.preset}`,
				`resolved: ${JSON.stringify(adapter.config)}`,
			].join("\n"),
			"info",
		);
	}
}
