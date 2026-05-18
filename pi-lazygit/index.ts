import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TUIController {
	stop(): void;
	start(): void;
	requestRender(force: boolean): void;
}

export function runFullscreenProcess(
	command: string,
	args: string[],
	tui: TUIController
): Promise<void> {
	return new Promise((resolve, reject) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");

		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			try {
				tui.start();
				tui.requestRender(true);
			} catch {}
			if (err) reject(err);
			else resolve();
		};

		const child = spawn(command, args, {
			stdio: "inherit",
			env: process.env,
		});

		child.on("close", () => finish());
		child.on("error", (err) => finish(err));
	});
}

function launchLazygit(ctx: ExtensionContext) {
	if (!ctx.hasUI) {
		ctx.ui.notify("lazygit requires TUI mode", "error");
		return;
	}

	return ctx.ui.custom<null>((tui, _theme, _kb, done) => {
		runFullscreenProcess("lazygit", [], tui)
			.then(() => done(null))
			.catch((err) => {
				ctx.ui.notify(`Failed to start lazygit: ${err.message}`, "error");
				done(null);
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
