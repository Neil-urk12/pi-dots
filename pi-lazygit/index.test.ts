import { describe, it, expect, vi } from "vitest";
import { runFullscreenProcess, type TUIController } from "./index";

function mockTUI(): TUIController & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		stop: () => calls.push("stop"),
		start: () => calls.push("start"),
		requestRender: (force: boolean) => calls.push(`requestRender(${force})`),
	};
}

describe("runFullscreenProcess", () => {
	it("resolves on successful exit", async () => {
		const tui = mockTUI();
		await runFullscreenProcess("echo", ["ok"], tui);
		expect(tui.calls).toContain("stop");
		expect(tui.calls).toContain("start");
		expect(tui.calls).toContain("requestRender(true)");
	});

	it("rejects on spawn error", async () => {
		const tui = mockTUI();
		await expect(
			runFullscreenProcess("definitely-not-a-real-command-xyz", [], tui),
		).rejects.toThrow();
	});

	it("still restarts TUI after spawn error", async () => {
		const tui = mockTUI();
		try {
			await runFullscreenProcess("definitely-not-a-real-command-xyz", [], tui);
		} catch {}
		expect(tui.calls).toContain("stop");
		expect(tui.calls).toContain("start");
	});

	it("TUI stop is called before process starts", async () => {
		const tui = mockTUI();
		await runFullscreenProcess("echo", ["ok"], tui);
		expect(tui.calls[0]).toBe("stop");
		expect(tui.calls[tui.calls.length - 2]).toBe("start");
		expect(tui.calls[tui.calls.length - 1]).toBe("requestRender(true)");
	});

	it("handles double-close safely", async () => {
		const tui = mockTUI();
		// Normal run — just verify it doesn't throw or call start() twice
		await runFullscreenProcess("echo", ["ok"], tui);
		const startCount = tui.calls.filter((c) => c === "start").length;
		expect(startCount).toBe(1);
	});
});
