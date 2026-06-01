import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModeSessionCoordinator } from "../dist/index.js";

// --- makeBypassKey collision tests ---
// makeBypassKey is not exported, so we test via evaluateToolCall behavior.
// After "Allow once", the same bypass key should be consumed on the NEXT identical call.
// Different inputs should NOT share a bypass key.

describe("one-shot bypass key uniqueness", () => {
  let coordinator;
  let mockPi;
  let mockCtx;

  beforeEach(async () => {
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
        select: vi.fn().mockResolvedValue("Deny — block this tool call"),
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
    await coordinator.initialize(mockCtx, "test-session");
    await coordinator.handleCommand("plan", async () => undefined);
  });

  it("bypass for input A should NOT apply to different input B", async () => {
    // Trigger "Allow once" for bash with destructive command "rm -rf /tmp/foo"
    mockCtx.ui.select.mockResolvedValueOnce("Allow once — run \"bash\" this time without switching mode");
    const resultA = await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/foo" });
    expect(resultA.block).toBe(false);

    // Now try bash with different destructive command "rm -rf /tmp/bar" — should NOT be bypassed
    // Default mock returns "Deny", so this should be blocked
    const resultB = await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/bar" });
    expect(resultB.block).toBe(true);
  });

  it("bypass is consumed after one retry", async () => {
    // Call 1: "Allow once" → bypass added → returns false
    mockCtx.ui.select.mockResolvedValueOnce("Allow once — run \"bash\" this time without switching mode");
    const result1 = await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/foo" });
    expect(result1.block).toBe(false);

    // Call 2: bypass consumed → returns false (retry allowed)
    const result2 = await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/foo" });
    expect(result2.block).toBe(false);

    // Call 3: bypass gone → policy applies → returns true (blocked)
    const result3 = await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/foo" });
    expect(result3.block).toBe(true);
  });
});

describe("one-shot bypass size cap", () => {
  let coordinator;
  let mockPi;
  let mockCtx;

  beforeEach(async () => {
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
        select: vi.fn().mockResolvedValue("Deny — block this tool call"),
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
    await coordinator.initialize(mockCtx, "test-session");
    await coordinator.handleCommand("plan", async () => undefined);
  });

  it("bypass set should not grow beyond 100 entries", async () => {
    // Add 150 bypasses by triggering "Allow once" with different inputs
    // Use destructive commands to trigger the block path
    for (let i = 0; i < 150; i++) {
      mockCtx.ui.select.mockResolvedValueOnce("Allow once — run \"bash\" this time without switching mode");
      await coordinator.evaluateToolCall("bash", { command: `rm -rf /tmp/unique-${i}` });
    }

    // The internal _oneShotBypasses set should be capped at 100
    // We can't access it directly, but we can verify behavior:
    // The oldest bypass (command "rm -rf /tmp/unique-0") should have been evicted
    // So calling it again should trigger the dialog, not be bypassed
    // Default mock returns "Deny", so this should be blocked
    const result = await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/unique-0" });
    expect(result.block).toBe(true); // Was evicted, so not bypassed
  });
});

describe("makeBypassKey robustness", () => {
  let coordinator;
  let mockPi;
  let mockCtx;

  beforeEach(async () => {
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
        select: vi.fn().mockResolvedValue("Deny — block this tool call"),
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
    await coordinator.initialize(mockCtx, "test-session");
    await coordinator.handleCommand("plan", async () => undefined);
  });

  it("should not crash when input has circular reference", async () => {
    const circular = { command: "rm -rf /tmp/foo" };
    circular.self = circular;

    const result = await coordinator.evaluateToolCall("bash", circular);
    expect(result).toBeDefined();
    expect(typeof result.block).toBe("boolean");
  });

  it("should handle null input gracefully", async () => {
    const result = await coordinator.evaluateToolCall("bash", null);
    expect(result).toBeDefined();
    expect(typeof result.block).toBe("boolean");
  });

  it("should handle undefined input gracefully", async () => {
    const result = await coordinator.evaluateToolCall("bash", undefined);
    expect(result).toBeDefined();
    expect(typeof result.block).toBe("boolean");
  });
});

describe("one-shot bypass session isolation", () => {
  it("bypasses should not leak across sessions", async () => {
    const mockPi = {
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

    const mockCtx = {
      ui: {
        notify: vi.fn(),
        confirm: vi.fn().mockResolvedValue(true),
        select: vi.fn().mockResolvedValue("Deny — block this tool call"),
        setStatus: vi.fn(),
        setEditorComponent: vi.fn(),
        theme: { fg: vi.fn().mockReturnValue("styled") },
      },
      sessionManager: {
        getEntries: vi.fn().mockReturnValue([]),
      },
    };

    const coordinator = new ModeSessionCoordinator(mockPi, "/test");
    coordinator.ctx = mockCtx;

    // Session 1: add a bypass
    await coordinator.initialize(mockCtx, "session-1");
    await coordinator.handleCommand("plan", async () => undefined);

    mockCtx.ui.select.mockResolvedValueOnce("Allow once — run \"bash\" this time without switching mode");
    await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/foo" });

    // Session 2: initialize with new session ID
    await coordinator.initialize(mockCtx, "session-2");
    await coordinator.handleCommand("plan", async () => undefined);

    // The bypass from session 1 should NOT apply in session 2
    const result = await coordinator.evaluateToolCall("bash", { command: "rm -rf /tmp/foo" });
    expect(result.block).toBe(true); // Bypass should have been cleared
  });
});
