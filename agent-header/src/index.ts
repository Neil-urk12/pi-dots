import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import os from "node:os";

import { HeaderLifecycle } from "./lifecycle.js";
import { renderHeader } from "./renderer.js";

export type { ColorFn, HeaderInput, Theme } from "./types.js";

export default function (pi: ExtensionAPI) {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "pi-header.json");

	const getProjectConfigPath = (cwd: string) => path.join(cwd, ".pi", "pi-header.json");

	let requestRender: () => void = () => {};

	const lifecycle = new HeaderLifecycle({
		globalConfigPath,
		getProjectConfigPath,
		onRenderNeeded: () => requestRender(),
	});

	// ── Commands ───────────────────────────────────────────────────

	pi.registerCommand("header", {
		description: "Toggle, refresh, or configure the ASCII header",
		handler: async (args, ctx) => {
			const command = args.trim();

			if (command === "refresh") {
				await lifecycle.refresh();
				if (ctx.hasUI) ctx.ui.notify("Header refreshed", "info");
				return;
			}

			if (command === "reload") {
				await lifecycle.reload(ctx);
				if (ctx.hasUI && lifecycle.isEnabled) installHeader(ctx);
				if (ctx.hasUI && !lifecycle.isEnabled) ctx.ui.setHeader(undefined);
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
				installHeader(ctx);
				ctx.ui.notify("ASCII header enabled", "info");
			} else {
				ctx.ui.setHeader(undefined);
				ctx.ui.notify("Built-in header restored", "info");
			}
		},
	});

	// ── Events ─────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		await lifecycle.start(ctx);
		if (ctx.hasUI && lifecycle.loadedError && lifecycle.isEnabled)
			ctx.ui.notify(`Config error: ${lifecycle.loadedError}`, "error");
		if (ctx.hasUI && lifecycle.isEnabled) installHeader(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		lifecycle.shutdown();
		requestRender = () => {};
		if (ctx.hasUI) ctx.ui.setHeader(undefined);
	});

	pi.on("model_select", () => {
		lifecycle.onModelSelect();
	});

	pi.on("tool_execution_end", (event) => {
		lifecycle.onToolExecutionEnd(event.toolName);
	});

	pi.on("user_bash", () => {
		lifecycle.onUserBash();
	});

	// ── UI helpers ──────────────────────────────────────────────────

	function installHeader(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader((_tui, _theme) => {
			requestRender = () => _tui.requestRender();

			return {
				invalidate() {},
				render(width: number): string[] {
					const input = lifecycle.getInput(ctx);
					return renderHeader(input, _theme, width);
				},
			};
		});
	}

	function notifyConfigStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (lifecycle.loadedError) {
			ctx.ui.notify(`ASCII header config error: ${lifecycle.loadedError}`, "error");
		} else if (lifecycle.loadedWarnings.length > 0) {
			ctx.ui.notify(
				`ASCII header config loaded with warnings: ${lifecycle.loadedWarnings.join("; ")}`,
				"warning",
			);
		} else {
			ctx.ui.notify("ASCII header config loaded", "info");
		}
	}

	function showConfig(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const loaded = lifecycle.loadedPaths.length ? lifecycle.loadedPaths.join("\n") : "none";
		const warnings = lifecycle.loadedWarnings.length ? lifecycle.loadedWarnings.join("\n") : "none";
		const projectPath = getProjectConfigPath(ctx.cwd);
		ctx.ui.notify(
			[
				"ASCII header config",
				`global: ${globalConfigPath}`,
				`project: ${projectPath}`,
				`loaded:\n${loaded}`,
				lifecycle.loadedError ? `error: ${lifecycle.loadedError}` : "error: none",
				`warnings:\n${warnings}`,
				`resolved: ${JSON.stringify(lifecycle.config)}`,
			].join("\n"),
			"info",
		);
	}
}
