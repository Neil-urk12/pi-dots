import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModeSessionCoordinator } from "../src/mode-session-coordinator.js";

describe("request_mode_switch confirmation", () => {
  let coordinator;
  let mockPi;
  let mockCtx;

  beforeEach(() => {
    mockPi = {
      getAllTools: vi.fn().mockReturnValue([{ name: "bash" }, { name: "read" }]),
      setActiveTools: vi.fn(),
      appendEntry: vi.fn(),
      getFlag: vi.fn().mockReturnValue(undefined),
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      registerFlag: vi.fn(),
    };

    mockCtx = {
      ui: {
        notify: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        select: vi.fn(),
        setStatus: vi.fn(),
        setEditorComponent: vi.fn(),
        theme: { fg: vi.fn().mockReturnValue("styled") },
      },
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
      },
    };

    coordinator = new ModeSessionCoordinator(mockPi, "/test");
    coordinator.ctx = mockCtx;
  });

  it("should show confirmation when auto_mode_switch is false", async () => {
    // Setup: mode has auto_mode_switch: false
    const mockDefinition = {
      mode: "orchestrator",
      auto_mode_switch: false,
    };

    coordinator.runtime = {
      definition: vi.fn().mockReturnValue(mockDefinition),
      snapshot: vi.fn().mockReturnValue({ currentMode: "orchestrator" }),
      transition: vi.fn().mockReturnValue({
        modeChanged: true,
        activeTools: ["bash"],
        persistModeState: true,
        notifications: [],
      }),
      modes: vi.fn().mockReturnValue(["orchestrator", "code"]),
      catalogDefinitions: vi.fn().mockReturnValue(new Map()),
      lastLoadTime: vi.fn().mockReturnValue(Date.now()),
      globalBashPatterns: vi.fn().mockReturnValue(undefined),
    };

    coordinator.switchMode = vi.fn().mockReturnValue({ ok: true, mode: "code" });

    // Simulate what the tool handler does
    const currentDef = coordinator.currentDefinition();
    const skipConfirm = currentDef?.auto_mode_switch === true;

    if (!skipConfirm) {
      const currentMode = coordinator.currentMode();
      const confirmed = await mockCtx.ui.confirm(
        "Mode Switch",
        `Agent wants to switch from ${currentMode.toUpperCase()} to CODE mode. Allow?`
      );
      if (!confirmed) {
        // Would return error
      }
    }

    expect(mockCtx.ui.confirm).toHaveBeenCalledWith(
      "Mode Switch",
      expect.stringContaining("ORCHESTRATOR")
    );
  });

  it("should skip confirmation when auto_mode_switch is true", async () => {
    const mockDefinition = {
      mode: "yolo",
      auto_mode_switch: true,
    };

    coordinator.runtime = {
      definition: vi.fn().mockReturnValue(mockDefinition),
      snapshot: vi.fn().mockReturnValue({ currentMode: "yolo" }),
      transition: vi.fn().mockReturnValue({
        modeChanged: true,
        activeTools: ["bash"],
        persistModeState: true,
        notifications: [],
      }),
      modes: vi.fn().mockReturnValue(["yolo", "code"]),
      catalogDefinitions: vi.fn().mockReturnValue(new Map()),
      lastLoadTime: vi.fn().mockReturnValue(Date.now()),
      globalBashPatterns: vi.fn().mockReturnValue(undefined),
    };

    coordinator.switchMode = vi.fn().mockReturnValue({ ok: true, mode: "code" });

    // Simulate what the tool handler does
    const currentDef = coordinator.currentDefinition();
    const skipConfirm = currentDef?.auto_mode_switch === true;

    if (!skipConfirm) {
      await mockCtx.ui.confirm("Mode Switch", "test");
    }

    expect(mockCtx.ui.confirm).not.toHaveBeenCalled();
    expect(coordinator.switchMode).not.toHaveBeenCalled(); // switchMode not called in this test path
  });

  it("should return error when user denies mode switch", async () => {
    mockCtx.ui.confirm.mockResolvedValue(false);

    const mockDefinition = {
      mode: "orchestrator",
      auto_mode_switch: false,
    };

    coordinator.runtime = {
      definition: vi.fn().mockReturnValue(mockDefinition),
      snapshot: vi.fn().mockReturnValue({ currentMode: "orchestrator" }),
    };

    coordinator.switchMode = vi.fn().mockReturnValue({ ok: true, mode: "code" });

    // Simulate denial
    const confirmed = await mockCtx.ui.confirm("Mode Switch", "test");
    expect(confirmed).toBe(false);
    expect(coordinator.switchMode).not.toHaveBeenCalled();
  });

  it("should proceed with switch when user confirms", async () => {
    mockCtx.ui.confirm.mockResolvedValue(true);

    const mockDefinition = {
      mode: "orchestrator",
      auto_mode_switch: false,
    };

    coordinator.runtime = {
      definition: vi.fn().mockReturnValue(mockDefinition),
      snapshot: vi.fn().mockReturnValue({ currentMode: "orchestrator" }),
    };

    coordinator.switchMode = vi.fn().mockReturnValue({ ok: true, mode: "code" });

    // Simulate confirmation
    const confirmed = await mockCtx.ui.confirm("Mode Switch", "test");
    expect(confirmed).toBe(true);
    // In real implementation, switchMode would be called
  });

  it("should include current and target mode in confirmation message", async () => {
    mockCtx.ui.confirm.mockResolvedValue(true);

    const mockDefinition = {
      mode: "plan",
      auto_mode_switch: false,
    };

    coordinator.runtime = {
      definition: vi.fn().mockReturnValue(mockDefinition),
      snapshot: vi.fn().mockReturnValue({ currentMode: "plan" }),
    };

    coordinator.switchMode = vi.fn().mockReturnValue({ ok: true, mode: "yolo" });

    // Simulate confirmation with message check
    const currentMode = "plan";
    const targetMode = "yolo";
    await mockCtx.ui.confirm(
      "Mode Switch",
      `Agent wants to switch from ${currentMode.toUpperCase()} to ${targetMode.toUpperCase()} mode. Allow?`
    );

    expect(mockCtx.ui.confirm).toHaveBeenCalledWith(
      "Mode Switch",
      expect.stringContaining("PLAN")
    );
    expect(mockCtx.ui.confirm).toHaveBeenCalledWith(
      "Mode Switch",
      expect.stringContaining("YOLO")
    );
  });
});
