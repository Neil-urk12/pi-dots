import { test, expect, vi } from "vitest";
import { ModeSessionCoordinator, lastSessionMode } from "../dist/index.js";

// --- checkAndReload error handling ---

test("checkAndReload catches hasChanges errors and resets reloadPending", async () => {
  const { ModeFileWatcher } = await import("../dist/index.js");
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const pi = mockPi();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(mockCtx());

  // Mock hasChanges to throw
  const watcher = coordinator.fileWatcher;
  const original = watcher.hasChanges;
  watcher.hasChanges = vi.fn().mockRejectedValue(new Error("stat boom"));

  // Should not throw
  await coordinator.checkAndReload();

  // Error was logged with prefix
  expect(consoleSpy).toHaveBeenCalledWith(
    "[pi-agent-modes] Error checking for mode file changes:",
    expect.objectContaining({ message: "stat boom" }),
  );

  // reloadPending was reset — calling again should not be blocked
  watcher.hasChanges.mockReset();
  watcher.hasChanges.mockResolvedValue(false);
  await coordinator.checkAndReload();
  expect(watcher.hasChanges).toHaveBeenCalled();

  // Restore
  watcher.hasChanges = original;
  consoleSpy.mockRestore();
});


// --- Mocks ---

function mockPi(overrides = {}) {
  return {
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "edit" }]),
    getFlag: vi.fn(() => undefined),
    ...overrides,
  };
}

function mockCtx(overrides = {}) {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      select: vi.fn(),
      setEditorComponent: vi.fn(),
      theme: {
        fg: vi.fn((_style, text) => text),
        borderColor: vi.fn((text) => text),
      },
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
    },
    ...overrides,
  };
}

// Built-in modes matching the real modes/ directory
const MODES_DIR = new URL("../modes/", import.meta.url).pathname;

// --- Tests ---

test("initialize loads catalog and sets default mode to orchestrator", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);

  await coordinator.initialize(ctx);

  expect(coordinator.currentMode()).toBe("orchestrator");
  expect(coordinator.modes().length).toBeGreaterThanOrEqual(5);
});

test("restoreMode uses CLI flag over session mode", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  coordinator.captureBaselineTools();

  coordinator.restoreMode("plan", "ask");

  expect(coordinator.currentMode()).toBe("plan");
});

test("restoreMode falls back to session mode when CLI flag invalid", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  coordinator.captureBaselineTools();

  coordinator.restoreMode("nonexistent", "code");

  expect(coordinator.currentMode()).toBe("code");
});

test("restoreMode keeps default when both flags invalid", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  coordinator.captureBaselineTools();

  coordinator.restoreMode("nonexistent", "also-bad");

  expect(coordinator.currentMode()).toBe("orchestrator");
});

test("captureBaselineTools calls pi.getAllTools", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  coordinator.captureBaselineTools();

  expect(pi.getAllTools).toHaveBeenCalled();
});

test("cycleMode advances to next mode", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const first = coordinator.currentMode();
  coordinator.cycleMode();
  const second = coordinator.currentMode();

  expect(second).not.toBe(first);
});

test("cycleMode notifies on mode change", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  coordinator.cycleMode();

  expect(ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("Mode:"),
    "info",
  );
});

test("handleCommand with mode name switches mode", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  await coordinator.handleCommand("plan", async () => undefined);

  expect(coordinator.currentMode()).toBe("plan");
  expect(pi.setActiveTools).toHaveBeenCalled();
  expect(pi.appendEntry).toHaveBeenCalledWith("mode-state", { mode: "plan" });
});

test("handleCommand with invalid mode notifies error", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const result = await coordinator.handleCommand("nonexistent", async () => undefined);

  expect(result).toBeUndefined();
  expect(ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("Invalid mode"),
    "error",
  );
});

test("handleCommand with no args triggers interactive picker", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const selectMode = vi.fn(async (options) => {
    const plan = options.find(o => o.name === "plan");
    return plan ? plan.name : undefined;
  });

  await coordinator.handleCommand(undefined, selectMode);

  expect(selectMode).toHaveBeenCalled();
  expect(coordinator.currentMode()).toBe("plan");
});

test("handleCommand with no args does nothing when picker returns undefined", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  const originalMode = coordinator.currentMode();

  await coordinator.handleCommand(undefined, async () => undefined);

  expect(coordinator.currentMode()).toBe(originalMode);
});

test("handleCommand reload calls reload", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  await coordinator.handleCommand("reload", async () => undefined);

  // After reload, should still have a valid mode
  expect(coordinator.modes().length).toBeGreaterThanOrEqual(5);
});

test("handleCommand status shows mode info", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  await coordinator.handleCommand("status", async () => undefined);

  expect(ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("Mode:"),
    "info",
  );
});

test("evaluateToolCall returns policy decision", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  // orchestrator has no bash_policy, defaults to "off" — all commands allowed
  const result = coordinator.evaluateToolCall("bash", { command: "rm -rf /" });

  expect(result).toEqual({ block: false });
});

test("evaluateToolCall blocks when fail-closed (no runtime)", () => {
  const pi = mockPi();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  // No initialize — runtime is undefined

  const result = coordinator.evaluateToolCall("edit", {});

  expect(result.block).toBe(true);
  expect(result.reason).toContain("fail-closed");
});

test("buildPromptInjection returns undefined when no suffix", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // Switch to yolo which has no prompt_suffix
  await coordinator.handleCommand("yolo", async () => undefined);

  const result = coordinator.buildPromptInjection();

  expect(result).toBeUndefined();
});

test("beforeProviderRequest returns payload unchanged when no injection", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // Switch to yolo which has no prompt_suffix
  await coordinator.handleCommand("yolo", async () => undefined);

  const payload = { system: "hello" };
  const result = coordinator.beforeProviderRequest(payload);

  expect(result).toBe(payload);
});

test("beforeProviderRequest injects mode prompt when suffix exists", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // Default mode is orchestrator, which has prompt_suffix

  const payload = { system: "hello" };
  coordinator.beforeProviderRequest(payload);

  expect(payload.system).toContain("[MODE: ORCHESTRATOR]");
  expect(payload.system).toContain("orchestrator mode");
});

test("turnEnd persists mode state", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  coordinator.turnEnd();

  expect(pi.appendEntry).toHaveBeenCalledWith("mode-state", { mode: coordinator.currentMode() });
});

test("currentDefinition returns active mode definition", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const def = coordinator.currentDefinition();

  expect(def).toBeDefined();
  expect(def.mode).toBe(coordinator.currentMode());
});

test("handleCommand without runtime returns undefined", async () => {
  const pi = mockPi();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  // No initialize — runtime and ctx are both undefined

  const result = await coordinator.handleCommand("plan", async () => undefined);

  expect(result).toBeUndefined();
});

// --- lastSessionMode ---

test("lastSessionMode extracts mode from session history", () => {
  const ctx = mockCtx({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "mode-state", data: { mode: "plan" } },
      ],
    },
  });

  expect(lastSessionMode(ctx)).toBe("plan");
});

test("lastSessionMode returns undefined when no entries", () => {
  const ctx = mockCtx({
    sessionManager: { getEntries: () => [] },
  });

  expect(lastSessionMode(ctx)).toBeUndefined();
});

test("lastSessionMode returns last entry when multiple exist", () => {
  const ctx = mockCtx({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "mode-state", data: { mode: "plan" } },
        { type: "custom", customType: "mode-state", data: { mode: "yolo" } },
      ],
    },
  });

  expect(lastSessionMode(ctx)).toBe("yolo");
});
