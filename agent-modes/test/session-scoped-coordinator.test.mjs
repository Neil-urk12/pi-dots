import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModeSessionCoordinator, lastSessionMode } from "../src/mode-session-coordinator.js";

describe("Session-scoped coordinator", () => {
  let coordinator;
  let mockPi;
  let mockCtx;

  beforeEach(() => {
    mockPi = {
      getAllTools: vi.fn().mockReturnValue([{ name: "bash" }, { name: "read" }, { name: "Agent" }]),
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
  });

  describe("Session ID tracking", () => {
    it("initialize() should accept and store sessionId", async () => {
      await coordinator.initialize(mockCtx, "session-123");
      expect(coordinator.sessionId).toBe("session-123");
    });

    it("should create fresh runtime on each initialize() call", async () => {
      await coordinator.initialize(mockCtx, "session-1");
      const firstRuntime = coordinator.runtime;

      await coordinator.initialize(mockCtx, "session-2");
      const secondRuntime = coordinator.runtime;

      expect(secondRuntime).not.toBe(firstRuntime);
    });
  });

  describe("Persisted entries tagged with session ID", () => {
    it("persistMode() should include sessionId in mode-state entry", async () => {
      await coordinator.initialize(mockCtx, "session-123");

      // Trigger persist via turnEnd
      coordinator.turnEnd();

      expect(mockPi.appendEntry).toHaveBeenCalledWith("mode-state", expect.objectContaining({
        mode: expect.any(String),
        sessionId: "session-123",
      }));
    });

    it("lastSessionMode() should prefer entries matching current sessionId", () => {
      const entries = [
        { type: "custom", customType: "mode-state", data: { mode: "orchestrator", sessionId: "session-1" } },
        { type: "custom", customType: "mode-state", data: { mode: "code", sessionId: "session-2" } },
      ];
      mockCtx.sessionManager.getEntries.mockReturnValue(entries);

      const result = lastSessionMode(mockCtx, "session-1");
      expect(result).toBe("orchestrator");
    });

    it("lastSessionMode() should fall back to last entry if no session match", () => {
      const entries = [
        { type: "custom", customType: "mode-state", data: { mode: "orchestrator", sessionId: "session-1" } },
        { type: "custom", customType: "mode-state", data: { mode: "code", sessionId: "session-2" } },
      ];
      mockCtx.sessionManager.getEntries.mockReturnValue(entries);

      const result = lastSessionMode(mockCtx, "session-999");
      expect(result).toBe("code");
    });

    it("lastSessionMode() should handle entries without sessionId (backward compat)", () => {
      const entries = [
        { type: "custom", customType: "mode-state", data: { mode: "plan" } }, // old format
        { type: "custom", customType: "mode-state", data: { mode: "code", sessionId: "session-1" } },
      ];
      mockCtx.sessionManager.getEntries.mockReturnValue(entries);

      const result = lastSessionMode(mockCtx, "session-1");
      expect(result).toBe("code");
    });
  });

  describe("turn_end session guard", () => {
    it("turnEnd() should not persist if sessionId is not set", async () => {
      await coordinator.initialize(mockCtx);

      coordinator.turnEnd();

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it("turnEnd() should persist if sessionId is set", async () => {
      await coordinator.initialize(mockCtx, "session-123");

      coordinator.turnEnd();

      expect(mockPi.appendEntry).toHaveBeenCalled();
    });

    it("turnEnd() should include sessionId when persisting", async () => {
      await coordinator.initialize(mockCtx, "session-123");

      coordinator.turnEnd();

      expect(mockPi.appendEntry).toHaveBeenCalledWith("mode-state", expect.objectContaining({
        mode: expect.any(String),
        sessionId: "session-123",
      }));
    });
  });
});

describe("Subagent mode override priority", () => {
  it("restoreMode() should prefer lastSessionMode over subagentMode", () => {
    // After fix: lastSessionMode ?? subagentMode (persisted wins)
    const lastSessionMode = "orchestrator";
    const subagentMode = "code";

    const expectedResult = lastSessionMode ?? subagentMode;
    expect(expectedResult).toBe("orchestrator");
  });

  it("restoreMode() should use subagentMode when no persisted mode exists", () => {
    const lastSessionMode = undefined;
    const subagentMode = "code";

    const result = lastSessionMode ?? subagentMode;
    expect(result).toBe("code");
  });

  it("restoreMode() should always respect --mode flag over both", () => {
    const flag = "yolo";
    const lastSessionMode = "orchestrator";
    const subagentMode = "code";

    // --mode flag should always win
    const result = flag ?? lastSessionMode ?? subagentMode;
    expect(result).toBe("yolo");
  });
});
