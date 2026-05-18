import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function launchLazygit(ctx: { hasUI: boolean; ui: any }) {
	if (!ctx.hasUI) {
		ctx.ui.notify("lazygit requires TUI mode", "error");
		return;
	}

	ctx.ui.custom<null>((tui, _theme, _kb, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");

		spawnSync("lazygit", [], {
			stdio: "inherit",
			env: process.env,
		});

		tui.start();
		tui.requestRender(true);

		done(null);
		return { render: () => [], invalidate: () => {} };
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("lazygit", {
		description: "Open lazygit in popup terminal",
		handler: async (_args, ctx) => {
			launchLazygit(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+g", {
		description: "Open lazygit",
		handler: async (ctx) => {
			launchLazygit(ctx);
		},
	});
}
