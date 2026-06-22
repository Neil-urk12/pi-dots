import { vi, describe, it, expect, beforeEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Mocks ──────────────────────────────────────────────────────

const {
	mockRefresh,
	mockReload,
	mockToggle,
	mockStart,
	mockShutdown,
	mockOnThinkingLevel,
	mockOnModelSelect,
	mockOnMessageStart,
	mockOnMessageEnd,
	mockOnMessageUpdate,
	mockOnToolExecutionStart,
	mockOnToolExecutionEnd,
	mockOnUserBash,
	mockGetFooterInput,
	mockIsEnabled,
	mockLoadedError,
	mockLoadedWarnings,
	mockLoadedPaths,
	mockConfig,
} = vi.hoisted(() => ({
	mockRefresh: vi.fn(async () => {}),
	mockReload: vi.fn(async () => {}),
	mockToggle: vi.fn(async () => true),
	mockStart: vi.fn(async () => {}),
	mockShutdown: vi.fn(),
	mockOnThinkingLevel: vi.fn(),
	mockOnModelSelect: vi.fn(),
	mockOnMessageStart: vi.fn(),
	mockOnMessageEnd: vi.fn(),
	mockOnMessageUpdate: vi.fn(),
	mockOnToolExecutionStart: vi.fn(),
	mockOnToolExecutionEnd: vi.fn(),
	mockOnUserBash: vi.fn(),
	mockGetFooterInput: vi.fn(() => ({
		modelId: "test",
		directory: "test",
		gitBranch: "main",
		gitDirtyCount: 0,
		contextUsed: 0,
		contextMax: 100000,
		totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		toksState: { state: "hidden" as const },
		sessionCost: 0,
		config: {},
	})),
	mockIsEnabled: vi.fn(() => true),
	mockLoadedError: vi.fn(() => undefined),
	mockLoadedWarnings: vi.fn(() => []),
	mockLoadedPaths: vi.fn(() => []),
	mockConfig: vi.fn(() => ({ preset: "default" })),
}));

vi.mock("./lifecycle.js", () => {
	return {
		FooterLifecycle: class {
			refresh = mockRefresh;
			reload = mockReload;
			toggle = mockToggle;
			start = mockStart;
			shutdown = mockShutdown;
			onThinkingLevel = mockOnThinkingLevel;
			onModelSelect = mockOnModelSelect;
			onMessageStart = mockOnMessageStart;
			onMessageEnd = mockOnMessageEnd;
			onMessageUpdate = mockOnMessageUpdate;
			onToolExecutionStart = mockOnToolExecutionStart;
			onToolExecutionEnd = mockOnToolExecutionEnd;
			onUserBash = mockOnUserBash;
			getFooterInput = mockGetFooterInput;
			get isEnabled() {
				return mockIsEnabled();
			}
			get loadedError() {
				return mockLoadedError();
			}
			get loadedWarnings() {
				return mockLoadedWarnings();
			}
			get loadedPaths() {
				return mockLoadedPaths();
			}
			get config() {
				return mockConfig();
			}
		},
	};
});

vi.mock("./renderer.js", () => ({
	renderFooter: vi.fn(() => ["rendered footer"]),
}));

vi.mock("./usage.js", () => ({
	extractOutputTokens: vi.fn(() => 42),
}));

import extensionFn from "./index.js";
import { renderFooter } from "./renderer.js";

// ── Helpers ────────────────────────────────────────────────────

function makeMockPi(): ExtensionAPI & {
	_commands: Record<string, (...args: unknown[]) => unknown>;
	_events: Record<string, (...args: unknown[]) => unknown>;
} {
	const _commands: Record<string, (...args: unknown[]) => unknown> = {};
	const _events: Record<string, (...args: unknown[]) => unknown> = {};
	return {
		registerCommand: vi.fn((name: string, opts: { handler: (...args: unknown[]) => unknown }) => {
			_commands[name] = opts.handler;
		}),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			_events[event] = handler;
		}),
		getThinkingLevel: vi.fn(() => undefined),
		_commands,
		_events,
	} as unknown as ExtensionAPI & {
		_commands: Record<string, (...args: unknown[]) => unknown>;
		_events: Record<string, (...args: unknown[]) => unknown>;
	};
}

function makeMockCtx(overrides?: Partial<ExtensionContext>): ExtensionContext {
	return {
		cwd: "/home/user/project",
		hasUI: true,
		model: { id: "test-model", contextWindow: 100000 } as ExtensionContext["model"],
		getContextUsage: () => ({ tokens: 50000 }),
		sessionManager: {
			getEntries: () => [],
		} as unknown as ExtensionContext["sessionManager"],
		ui: {
			notify: vi.fn(),
			setFooter: vi.fn(),
			theme: { fg: (_c: string, t: string) => t },
		} as unknown as ExtensionContext["ui"],
		...overrides,
	} as ExtensionContext;
}

// ── Tests ──────────────────────────────────────────────────────

describe("extension entry point", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockIsEnabled.mockReturnValue(true);
		mockLoadedError.mockReturnValue(undefined);
		mockLoadedWarnings.mockReturnValue([]);
		mockLoadedPaths.mockReturnValue([]);
		mockToggle.mockResolvedValue(true);
	});

	it("registers the footer command", () => {
		const pi = makeMockPi();
		extensionFn(pi);
		expect(pi.registerCommand).toHaveBeenCalledWith("footer", expect.any(Object));
	});

	it("registers expected event listeners", () => {
		const pi = makeMockPi();
		extensionFn(pi);

		const expectedEvents = [
			"session_start",
			"session_shutdown",
			"thinking_level_select",
			"model_select",
			"message_start",
			"message_end",
			"message_update",
			"tool_execution_start",
			"tool_execution_end",
			"user_bash",
		];
		for (const event of expectedEvents) {
			expect(pi._events[event]).toBeDefined();
		}
	});

	// ── Command: toggle ────────────────────────────────────

	describe("footer command — toggle", () => {
		it("calls toggle and notifies when enabling", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			mockToggle.mockResolvedValue(true);
			await pi._commands["footer"]("", ctx);

			expect(mockToggle).toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith("Clean footer enabled", "info");
			expect(ctx.ui.setFooter).toHaveBeenCalled();
		});

		it("calls toggle and notifies when disabling", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			mockToggle.mockResolvedValue(false);
			await pi._commands["footer"]("", ctx);

			expect(mockToggle).toHaveBeenCalled();
			expect(ctx.ui.setFooter).toHaveBeenCalledWith(undefined);
			expect(ctx.ui.notify).toHaveBeenCalledWith("Default footer restored", "info");
		});

		it("skips UI calls when hasUI is false", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx({ hasUI: false } as Partial<ExtensionContext>);

			mockToggle.mockResolvedValue(true);
			await pi._commands["footer"]("", ctx);

			expect(mockToggle).toHaveBeenCalled();
			// No crash, no UI calls
		});
	});

	// ── Command: refresh ───────────────────────────────────

	describe("footer command — refresh", () => {
		it("calls lifecycle.refresh and notifies", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			await pi._commands["footer"]("refresh", ctx);

			expect(mockRefresh).toHaveBeenCalled();
			expect(ctx.ui.notify).toHaveBeenCalledWith("Footer refreshed", "info");
		});

		it("skips notification when hasUI is false", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx({ hasUI: false } as Partial<ExtensionContext>);

			await pi._commands["footer"]("refresh", ctx);

			expect(mockRefresh).toHaveBeenCalled();
		});
	});

	// ── Command: reload ────────────────────────────────────

	describe("footer command — reload", () => {
		it("calls lifecycle.reload", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			await pi._commands["footer"]("reload", ctx);

			expect(mockReload).toHaveBeenCalledWith(ctx);
		});

		it("installs footer when enabled after reload", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			mockIsEnabled.mockReturnValue(true);
			await pi._commands["footer"]("reload", ctx);

			expect(ctx.ui.setFooter).toHaveBeenCalled();
		});

		it("removes footer when disabled after reload", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			mockIsEnabled.mockReturnValue(false);
			await pi._commands["footer"]("reload", ctx);

			expect(ctx.ui.setFooter).toHaveBeenCalledWith(undefined);
		});
	});

	// ── Command: config ────────────────────────────────────

	describe("footer command — config", () => {
		it("shows config info via notify", async () => {
			mockLoadedPaths.mockReturnValue(["/home/user/.pi/agent/clean-footer.json"]);
			mockConfig.mockReturnValue({ preset: "default", showGit: true });

			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			await pi._commands["footer"]("config", ctx);

			expect(ctx.ui.notify).toHaveBeenCalled();
			const notifyArg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(notifyArg).toContain("Clean footer config");
			expect(notifyArg).toContain("preset: default");
		});

		it("skips when hasUI is false", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx({ hasUI: false } as Partial<ExtensionContext>);

			await pi._commands["footer"]("config", ctx);

			// No crash
		});
	});

	// ── Event: session_start ───────────────────────────────

	describe("session_start event", () => {
		it("starts lifecycle and installs footer when enabled", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			mockIsEnabled.mockReturnValue(true);
			mockLoadedError.mockReturnValue(undefined);
			await pi._events["session_start"]({}, ctx);

			expect(mockStart).toHaveBeenCalledWith(ctx);
			expect(ctx.ui.setFooter).toHaveBeenCalled();
		});

		it("does not install footer when disabled", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			mockIsEnabled.mockReturnValue(false);
			await pi._events["session_start"]({}, ctx);

			expect(mockStart).toHaveBeenCalled();
			expect(ctx.ui.setFooter).not.toHaveBeenCalled();
		});

		it("shows error notification when config has error", async () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			mockIsEnabled.mockReturnValue(true);
			mockLoadedError.mockReturnValue("bad json");
			await pi._events["session_start"]({}, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("bad json"), "error");
		});
	});

	it("render returns empty array when renderFooter throws", async () => {
		const pi = makeMockPi();
		extensionFn(pi);
		const ctx = makeMockCtx();

		mockIsEnabled.mockReturnValue(true);
		await pi._events["session_start"]({}, ctx);

		// Get the render function passed to setFooter
		const setFooterMock = ctx.ui.setFooter as ReturnType<typeof vi.fn>;
		const setFooterCall = setFooterMock.mock.calls.find(
			(call: unknown[]) => typeof call[0] === "function",
		);
		expect(setFooterCall).toBeDefined();

		const footerObj = setFooterCall![0](
			{ requestRender: vi.fn() },
			{ fg: (_c: string, t: string) => t },
		);

		vi.mocked(renderFooter).mockImplementationOnce(() => {
			throw new Error("render failed");
		});

		const result = footerObj.render(80);
		expect(result).toEqual([]);
	});

	// ── Event: session_shutdown ────────────────────────────

	describe("session_shutdown event", () => {
		it("shuts down lifecycle and removes footer", () => {
			const pi = makeMockPi();
			extensionFn(pi);
			const ctx = makeMockCtx();

			pi._events["session_shutdown"]({}, ctx);

			expect(mockShutdown).toHaveBeenCalled();
			expect(ctx.ui.setFooter).toHaveBeenCalledWith(undefined);
		});
	});

	// ── Event: thinking_level_select ───────────────────────

	describe("thinking_level_select event", () => {
		it("forwards level to lifecycle", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["thinking_level_select"]({ level: "high" });

			expect(mockOnThinkingLevel).toHaveBeenCalledWith("high");
		});
	});

	// ── Event: model_select ────────────────────────────────

	describe("model_select event", () => {
		it("calls onModelSelect", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["model_select"]({});

			expect(mockOnModelSelect).toHaveBeenCalled();
		});
	});

	// ── Event: message_start ──────────────────────────────

	describe("message_start event", () => {
		it("forwards assistant role to lifecycle", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["message_start"]({ message: { role: "assistant" } });

			expect(mockOnMessageStart).toHaveBeenCalledWith("assistant");
		});

		it("forwards user role to lifecycle", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["message_start"]({ message: { role: "user" } });

			expect(mockOnMessageStart).toHaveBeenCalledWith("user");
		});
	});

	// ── Event: message_update ─────────────────────────────

	describe("message_update event", () => {
		it("forwards type, delta, and outputTokens for assistant messages", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["message_update"]({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			});

			expect(mockOnMessageUpdate).toHaveBeenCalledWith("text_delta", "hello", 42);
		});

		it("passes undefined delta when streamEvent has no delta key", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["message_update"]({
				message: { role: "assistant" },
				assistantMessageEvent: { type: "start" },
			});

			expect(mockOnMessageUpdate).toHaveBeenCalledWith("start", undefined, 42);
		});

		it("ignores non-assistant messages", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["message_update"]({
				message: { role: "user" },
				assistantMessageEvent: { type: "text_delta", delta: "hi" },
			});

			expect(mockOnMessageUpdate).not.toHaveBeenCalled();
		});
	});

	// ── Event: message_end ─────────────────────────────────

	describe("message_end event", () => {
		it("extracts output tokens for assistant messages", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["message_end"]({
				message: { role: "assistant", usage: { output: 42 } },
			});

			expect(mockOnMessageEnd).toHaveBeenCalledWith("assistant", 42);
		});

		it("skips output token extraction for non-assistant", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["message_end"]({
				message: { role: "user" },
			});

			expect(mockOnMessageEnd).toHaveBeenCalledWith("user", undefined);
		});
	});

	// ── Event: tool_execution_end ──────────────────────────

	describe("tool_execution_end event", () => {
		it("forwards tool name to lifecycle", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["tool_execution_end"]({ toolName: "bash" });

			expect(mockOnToolExecutionEnd).toHaveBeenCalledWith("bash");
		});
	});

	// ── Event: tool_execution_start ────────────────────────

	describe("tool_execution_start event", () => {
		it("forwards tool name to lifecycle", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["tool_execution_start"]({ toolName: "bash" });

			expect(mockOnToolExecutionStart).toHaveBeenCalledWith("bash");
		});
	});

	// ── Event: user_bash ──────────────────────────────────

	describe("user_bash event", () => {
		it("calls onUserBash", () => {
			const pi = makeMockPi();
			extensionFn(pi);

			pi._events["user_bash"]({});

			expect(mockOnUserBash).toHaveBeenCalled();
		});
	});
});
