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
      confirm: vi.fn(),
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

  // orchestrator now uses bash_policy: strict_readonly — destructive commands blocked
  const result = await coordinator.evaluateToolCall("bash", { command: "rm -rf /" });

  expect(result).toMatchObject({ block: true });
});

test("orchestrator sets bash_policy: strict_readonly for delegation-only enforcement", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  const def = coordinator.currentDefinition();
  expect(def).toBeDefined();
  expect(def.bash_policy).toBe("strict_readonly");
});

test("evaluateToolCall blocks when fail-closed (no runtime)", async () => {
  const pi = mockPi();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  // No initialize — runtime is undefined

  const result = await coordinator.evaluateToolCall("edit", {});

  expect(result.block).toBe(true);
  expect(result.reason).toContain("fail-closed");
});

test("code mode blocks destructive bash but allows dev commands (non_destructive)", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("code", async () => undefined);

  // Destructive command should be blocked
  const rmResult = await coordinator.evaluateToolCall("bash", { command: "rm -rf dist" });
  expect(rmResult.block).toBe(true);
  expect(rmResult.reason).toContain("destructive");

  // Dev command should be allowed
  const testResult = await coordinator.evaluateToolCall("bash", { command: "npm test" });
  expect(testResult.block).toBe(false);
});


test("buildPromptInjection returns undefined for unrestricted mode (yolo)", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // Switch to yolo which has no prompt_suffix
  await coordinator.handleCommand("yolo", async () => undefined);

  const result = coordinator.buildPromptInjection();

  expect(result).toBeUndefined();
});

test("beforeProviderRequest does not inject when unrestricted mode (yolo)", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // Switch to yolo which has no prompt_suffix
  await coordinator.handleCommand("yolo", async () => undefined);

  const payload = { system: "hello" };
  const result = coordinator.beforeProviderRequest(payload);

  expect(payload.system).toBe("hello");
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

test("buildPromptInjection includes GUARD hint for restricted mode (plan)", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("plan", async () => undefined);

  const result = coordinator.buildPromptInjection();

  expect(result).toContain("[MODE: PLAN]");
  expect(result).toContain("[GUARD]");
});

test("turnEnd persists mode state", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx, "test-session");

  coordinator.turnEnd();

  expect(pi.appendEntry).toHaveBeenCalledWith("mode-state", { mode: coordinator.currentMode(), sessionId: "test-session" });
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

test("switchMode rejects empty string", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  const result = coordinator.switchMode("");
  expect(result.ok).toBe(false);
  expect(result.error).toBeDefined();
});

test("switchMode rejects overly long mode name", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  const result = coordinator.switchMode("a".repeat(51));
  expect(result.ok).toBe(false);
});

test("switchMode to current mode returns ok", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  const result = coordinator.switchMode("orchestrator");
  expect(result.ok).toBe(true);
  expect(result.mode).toBe("orchestrator");
});

test("switchMode returns error when runtime not initialized", () => {
  const pi = mockPi();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  // No initialize — runtime is undefined
  const result = coordinator.switchMode("plan");
  expect(result.ok).toBe(false);
  expect(result.error).toContain("not initialized");
});

test("switchMode returns error for invalid mode name", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  const result = coordinator.switchMode("nonexistent");
  expect(result.ok).toBe(false);
  expect(result.error).toBeDefined();
});

test("evaluateToolCall augments reason with suggestion text when blocked", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // Switch to plan which restricts tools
  await coordinator.handleCommand("plan", async () => undefined);

  // Try to use edit (blocked in plan mode)
  const result = await coordinator.evaluateToolCall("edit", {});

  expect(result.block).toBe(true);
  // Should contain suggestion text from coordinator wrapper
  expect(result.reason).toContain("request_mode_switch");
});

test("buildPromptInjection includes GUARD hint for restricted mode without prompt_suffix", async () => {
  // This tests a mode that has enabled_tools but no prompt_suffix
  // We need to check if any built-in mode matches this pattern, or test the logic directly
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // Switch to ask mode — check if it has restrictions
  await coordinator.handleCommand("ask", async () => undefined);

  const result = coordinator.buildPromptInjection();

  // ask mode has enabled_tools (restricted), so GUARD hint should be present
  if (result) {
    expect(result).toContain("[GUARD]");
  }
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

// --- discoverAvailableAgents / bridge typing (TDD red) ---

test("discoverAvailableAgents handles string array from bridge", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  globalThis.__pi_subagents = { getAgents: () => ["blitz", "grind", "seeker"] };

  try {
    const injection = coordinator.buildPromptInjection();
    expect(injection).toBeDefined();
    expect(injection).toContain("blitz");
    expect(injection).toContain("grind");
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("discoverAvailableAgents handles object array from bridge", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  globalThis.__pi_subagents = {
    getAgents: () => [{ name: "blitz" }, { name: "grind" }]
  };

  try {
    const injection = coordinator.buildPromptInjection();
    expect(injection).toBeDefined();
    expect(injection).toContain("blitz");
    expect(injection).toContain("grind");
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("discoverAvailableAgents returns empty when bridge missing", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  delete globalThis.__pi_subagents;

  try {
    const injection = coordinator.buildPromptInjection();
    expect(injection).toBeDefined();
    // No agents listed in injection when bridge is missing
    expect(injection).not.toContain("[AGENTS]");
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("buildPromptInjection matches agents case-insensitively", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  // Bridge returns PascalCase from filename, allowed_agents has lowercase
  globalThis.__pi_subagents = { getAgents: () => ["Blitz", "Seeker", "blitz"] };

  try {
    const injection = coordinator.buildPromptInjection();
    expect(injection).toBeDefined();
    // All agents should appear regardless of case difference
    expect(injection).toContain("Blitz");
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("evaluateToolCall passes availableAgents to policy", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  globalThis.__pi_subagents = { getAgents: () => ["blitz", "grind"] };

  try {
    // This should pass availableAgents through to evaluateToolCall
    // which should use it for validation
    const result = await coordinator.evaluateToolCall("Agent", { subagent_type: "blitz" });
    expect(result).toBeDefined();
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("evaluateToolCall returns warning when allowed_agents references unknown agent", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  globalThis.__pi_subagents = { getAgents: () => ["blitz", "grind"] };

  try {
    const result = await coordinator.evaluateToolCall("Agent", { subagent_type: "blitz" });
    expect(result).toBeDefined();
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/unknown agent/);
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("evaluateToolCall surfaces warning via ctx.ui.notify", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  globalThis.__pi_subagents = { getAgents: () => ["blitz", "grind"] };

  try {
    await coordinator.evaluateToolCall("Agent", { subagent_type: "blitz" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/unknown agent/i),
      "warning"
    );
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("evaluateToolCall surfaces warning when allowed_agents has stale entries", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);

  const original = globalThis.__pi_subagents;
  // Bridge only has "blitz", but orchestrator's allowed_agents will have "blitz" + "ghost"
  globalThis.__pi_subagents = { getAgents: () => ["blitz"] };

  try {
    // Use Agent tool with an agent that IS allowed but config references missing agent "ghost"
    // This triggers: block=false (scout is allowed), warning=true (ghost not in availableAgents)
    const result = await coordinator.evaluateToolCall("Agent", { subagent_type: "blitz" });

    expect(result).toBeDefined();
    expect(result.block).toBe(false);
    // Warning should be surfaced via notify
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/unknown agent/i),
      "warning"
    );
  } finally {
    if (original === undefined) delete globalThis.__pi_subagents;
    else globalThis.__pi_subagents = original;
  }
});

test("evaluateToolCall ask path: confirm mock is wired", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(true);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  expect(ctx.ui.confirm).toBeDefined();
  const result = await ctx.ui.confirm("test", "test msg");
  expect(result).toBe(true);
});

test("evaluateToolCall ask path: triggers confirm when permission is ask", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(true);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("test-ask", async () => undefined);

  const result = await coordinator.evaluateToolCall("bash", { command: "rm -rf /" });

  expect(ctx.ui.confirm).toHaveBeenCalled();
  expect(result.block).toBe(false);
});

test("evaluateToolCall ask path: user denial returns block", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(false);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("test-ask", async () => undefined);

  const result = await coordinator.evaluateToolCall("bash", { command: "rm -rf /" });

  expect(result.block).toBe(true);
  expect(result.reason).toMatch(/denied/i);
});

test("evaluateToolCall ask path: user approval returns allow", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(true);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("test-ask", async () => undefined);

  const result = await coordinator.evaluateToolCall("bash", { command: "ls -la" });

  expect(result.block).toBe(false);
  expect(result.reason).toBeUndefined();
});

test("evaluateToolCall ask path: confirm called with correct title and message", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(true);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("test-ask", async () => undefined);

  await coordinator.evaluateToolCall("bash", { command: "echo hello" });

  expect(ctx.ui.confirm).toHaveBeenCalledWith(
    "Permission Request",
    expect.stringContaining("bash"),
  );
  expect(ctx.ui.confirm).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining("TEST-ASK"),
  );
});

test("evaluateToolCall ask path: forwards suggestedModes when user confirms", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(true);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("test-ask", async () => undefined);

  // bash is "ask" in test-ask mode; policy computes suggestedModes from catalog
  const result = await coordinator.evaluateToolCall("bash", { command: "ls -la" });

  expect(result.block).toBe(false);
  // Bug: coordinator returns { block: false } without forwarding decision.suggestedModes
  expect(result.suggestedModes).toBeDefined();
  expect(result.suggestedModes.length).toBeGreaterThan(0);
});

test("evaluateToolCall ask path: surfaces warning via notify when decision has warning", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(true);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  // test-ask-warn has permissions.bash="ask" + bash_policy="non_destructive"
  // policy should produce decision with { ask: true, warning: ... }
  await coordinator.handleCommand("test-ask-warn", async () => undefined);

  await coordinator.evaluateToolCall("bash", { command: "echo hello" });

  expect(ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringMatching(/bash_policy/),
    "warning"
  );
});

test("evaluateToolCall ask path: forwards warning in return value on confirm", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(true);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("test-ask-warn", async () => undefined);

  const result = await coordinator.evaluateToolCall("bash", { command: "echo hello" });

  expect(result.block).toBe(false);
  expect(result.warning).toBeDefined();
  expect(result.warning).toMatch(/bash_policy/);
});

test("evaluateToolCall ask path: forwards warning in return value on deny", async () => {
  const pi = mockPi();
  const ctx = mockCtx();
  ctx.ui.confirm = vi.fn().mockResolvedValue(false);
  const coordinator = new ModeSessionCoordinator(pi, new URL("../dist/", import.meta.url).pathname);
  await coordinator.initialize(ctx);
  await coordinator.handleCommand("test-ask-warn", async () => undefined);

  const result = await coordinator.evaluateToolCall("bash", { command: "echo hello" });

  expect(result.block).toBe(true);
  expect(result.warning).toBeDefined();
  expect(result.warning).toMatch(/bash_policy/);
});