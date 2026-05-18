import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function launchLazygit(ctx: { hasUI: boolean; ui: any }) {
	if (!ctx.hasUI) {
		ctx.ui.notify("lazygit requires TUI mode", "error");
		return;
	}

	return ctx.ui.custom<null>((tui, _theme, _kb, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");

		const child = spawn("lazygit", [], {
			stdio: "inherit",
			env: process.env,
		});

		child.on("close", () => {
			tui.start();
			tui.requestRender(true);
			done(null);
		});

		child.on("error", (err) => {
			tui.start();
			tui.requestRender(true);
			done(null);
			ctx.ui.notify(`Failed to start lazygit: ${err.message}`, "error");
		});

		return { render: () => [], invalidate: () => {} };
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("lazygit", {
		description: "Open lazygit in popup terminal",
		handler: async (_args, ctx) => {
			await launchLazygit(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+g", {
		description: "Open lazygit",
		handler: async (ctx) => {
			await launchLazygit(ctx);
		},
	});
}
