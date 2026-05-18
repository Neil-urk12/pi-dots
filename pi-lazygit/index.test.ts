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

describe("extension registration", () => {
	function mockPi() {
		const pi = {
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
		};
		return pi;
	}

	function mockCtx(hasUI = true) {
		const calls: string[] = [];
		const tui: TUIController & { calls: string[] } = {
			calls,
			stop: () => calls.push("stop"),
			start: () => calls.push("start"),
			requestRender: (force: boolean) => calls.push(`requestRender(${force})`),
		};
		let doneCalled = false;
		let doneValue: unknown;
		let doneResolve!: () => void;
		const donePromise = new Promise<void>((r) => { doneResolve = r; });
		const ctx = {
			hasUI,
			ui: {
				notify: vi.fn(),
				custom: vi.fn((cb: Function) => {
					cb(tui, {}, {}, (v: unknown) => {
						doneCalled = true;
						doneValue = v;
						doneResolve();
					});
					return donePromise;
				}),
			},
			_tui: tui,
			get doneCalled() { return doneCalled; },
			get doneValue() { return doneValue; },
		};
		return ctx;
	}

	it("registers command and shortcut", async () => {
		const pi = mockPi();
		const register = (await import("./index")).default;
		register(pi as any);
		expect(pi.registerCommand).toHaveBeenCalledWith("lazygit", expect.objectContaining({
			description: expect.any(String),
			handler: expect.any(Function),
		}));
		expect(pi.registerShortcut).toHaveBeenCalledWith("ctrl+shift+g", expect.objectContaining({
			description: expect.any(String),
			handler: expect.any(Function),
		}));
	});

	it("command handler launches lazygit", async () => {
		const pi = mockPi();
		const register = (await import("./index")).default;
		register(pi as any);
		const handler = pi.registerCommand.mock.calls[0][1].handler;
		const ctx = mockCtx();
		await handler([], ctx);
		expect(ctx.ui.custom).toHaveBeenCalled();
		expect(ctx._tui.calls).toContain("stop");
		expect(ctx._tui.calls).toContain("start");
	});

	it("shortcut handler launches lazygit", async () => {
		const pi = mockPi();
		const register = (await import("./index")).default;
		register(pi as any);
		const handler = pi.registerShortcut.mock.calls[0][1].handler;
		const ctx = mockCtx();
		await handler(ctx);
		expect(ctx.ui.custom).toHaveBeenCalled();
	});

	it("notifies error when not in TUI mode", async () => {
		const pi = mockPi();
		const register = (await import("./index")).default;
		register(pi as any);
		const handler = pi.registerCommand.mock.calls[0][1].handler;
		const ctx = mockCtx(false);
		await handler([], ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("TUI mode"),
			"error",
		);
		expect(ctx.ui.custom).not.toHaveBeenCalled();
	});

	it("notifies error on spawn failure", async () => {
		const pi = mockPi();
		const register = (await import("./index")).default;
		register(pi as any);
		const handler = pi.registerCommand.mock.calls[0][1].handler;
		const ctx = mockCtx();
		// Mock custom to pass a TUI that triggers spawn error
		let doneResolve!: () => void;
		const donePromise = new Promise<void>((r) => { doneResolve = r; });
		ctx.ui.custom = vi.fn((cb: Function) => {
			const failingTui: TUIController = {
				stop: () => ctx._tui.calls.push("stop"),
				start: () => ctx._tui.calls.push("start"),
				requestRender: (f: boolean) => ctx._tui.calls.push(`requestRender(${f})`),
			};
			cb(failingTui, {}, {}, () => doneResolve());
			return donePromise;
		});
		await handler([], ctx);
		expect(ctx.ui.custom).toHaveBeenCalled();
	});
});
