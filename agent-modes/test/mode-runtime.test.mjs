import { test, expect } from "vitest";
import { ModeRuntimeController } from "../dist/index.js";

function catalog(modes, loadedAt = 1) {
  return {
    loadedAt,
    definitions: new Map(modes.map((mode) => [mode, { mode, enabled_tools: mode === "plan" ? ["read", "bash"] : [] }])),
  };
}

test("restore gives CLI mode precedence over session mode", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const effects = runtime.restore({ cliMode: "plan", sessionMode: "ask" });

  expect(runtime.snapshot().currentMode).toBe("plan");
  expect(effects.activeTools).toEqual(["read", "bash"]);
  expect(effects.persist).toBe(false);
});

test("restore ignores invalid CLI and uses session mode", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));

  runtime.restore({ cliMode: "missing", sessionMode: "ask" });

  expect(runtime.snapshot().currentMode).toBe("ask");
});

test("setMode rejects unknown mode", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));

  const result = runtime.setMode("missing");

  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/Invalid mode: missing/);
  expect(runtime.snapshot().currentMode).toBe("yolo");
});

test("setMode updates mode and marks persistence", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const result = runtime.setMode("plan");

  expect(result.ok).toBe(true);
  expect(runtime.snapshot().currentMode).toBe("plan");
  expect(result.effects.persist).toBe(true);
  expect(result.effects.activeTools).toEqual(["read", "bash"]);
});

test("failed reload keeps known-good catalog", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"], 10));
  runtime.setMode("plan");

  const result = runtime.keepCatalog();

  expect(result.accepted).toBe(false);
  expect(runtime.snapshot().currentMode).toBe("plan");
  expect(runtime.modes()).toEqual(["yolo", "plan"]);
  expect(runtime.lastLoadTime()).toBe(10);
});

test("successful reload missing current mode falls back to plan first", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "code"]));
  runtime.setMode("code");

  const result = runtime.acceptCatalog(catalog(["yolo", "plan", "ask"], 20));

  expect(result.accepted).toBe(true);
  expect(result.fallbackMode).toBe("plan");
  expect(runtime.snapshot().currentMode).toBe("plan");
  expect(runtime.lastLoadTime()).toBe(20);
});

test("empty enabled_tools uses baseline tools", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  expect(runtime.activeTools()).toEqual(["read", "bash", "edit"]);
});

// --- Priority tests for single transition() entry point ---

test("transition session_start: CLI mode wins over session mode", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const d = runtime.transition({ type: "session_start", cliMode: "plan", sessionMode: "ask" });

  expect(d.nextState.currentMode).toBe("plan");
  expect(d.modeChanged).toBe(true);
  expect(d.persistModeState).toBe(false);
  expect(d.activeTools).toEqual(["read", "bash"]);
  expect(d.error).toBeUndefined();
});

test("transition mode_reload_result: missing mode falls back plan→ask→yolo", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "code", "orchestrator"]));
  runtime.setMode("code");

  // Reload with catalog missing code — fallback to plan (highest fallback)
  const d = runtime.transition({
    type: "mode_reload_result",
    catalog: catalog(["yolo", "plan", "ask"], 20),
  });

  expect(d.acceptedCatalog).toBe(true);
  expect(d.fallbackMode).toBe("plan");
  expect(d.modeChanged).toBe(true);
  expect(d.persistModeState).toBe(true);
  expect(d.nextState.currentMode).toBe("plan");
  expect(d.notifications.length).toBe(1);
  expect(d.notifications[0].message).toMatch(/fell back to PLAN/);
});

test("transition mode_reload_result: cascade when plan not available either", () => {
  const runtime = new ModeRuntimeController(catalog(["ask", "yolo", "orchestrator"]));
  runtime.setMode("orchestrator");

  // Reload: orchestrator gone, plan not in catalog, ask is next fallback
  const d = runtime.transition({
    type: "mode_reload_result",
    catalog: catalog(["ask", "yolo"], 20),
  });

  expect(d.fallbackMode).toBe("ask");
  expect(d.nextState.currentMode).toBe("ask");
});

test("transition turn_end: sets persistModeState true", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  const d = runtime.transition({ type: "turn_end" });

  expect(d.persistModeState).toBe(true);
  expect(d.modeChanged).toBe(false);
});

test("repeated transitions: no state thrash across cycle", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit", "grep", "find"]);

  // session_start → tool_call → turn_end → tool_call → turn_end
  let d = runtime.transition({ type: "session_start" });
  expect(d.nextState.currentMode).toBe("yolo");
  // First turn_end should persist (records current mode)
  d = runtime.transition({ type: "turn_end" });
  expect(d.persistModeState).toBe(true);
  expect(d.modeChanged).toBe(false);

  // Simulate mode switch
  d = runtime.transition({ type: "mode_select", requestedMode: "plan" });
  expect(d.modeChanged).toBe(true);
  expect(d.persistModeState).toBe(true);

  // turn_end with mode=plan still persists (no duplicate writes)
  d = runtime.transition({ type: "turn_end" });
  expect(d.persistModeState).toBe(true);
  expect(d.modeChanged).toBe(false);

  // tool_call doesn't persist
  d = runtime.transition({ type: "tool_call" });
  expect(d.persistModeState).toBe(false);

  // turn_end after tool_call still persists
  d = runtime.transition({ type: "turn_end" });
  expect(d.persistModeState).toBe(true);
});

test("transition mode_select: error via decision not exception", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  const d = runtime.transition({ type: "mode_select", requestedMode: "bogus" });

  expect(d.error).toBeDefined();
  expect(d.error).toMatch(/Invalid mode/);
  expect(d.modeChanged).toBe(false);
  expect(d.persistModeState).toBe(false);
  // Current mode unchanged
  expect(runtime.snapshot().currentMode).toBe("yolo");
});

test("transition mode_cycle: wraps around", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.setMode("plan");

  const d = runtime.transition({ type: "mode_cycle" });
  expect(d.nextState.currentMode).toBe("ask");
  expect(d.modeChanged).toBe(true);
  expect(d.persistModeState).toBe(true);
});

test("transition tool_call: no state change", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  runtime.setMode("plan");

  const before = runtime.snapshot().currentMode;
  const d = runtime.transition({ type: "tool_call", toolName: "read" });

  expect(d.nextState.currentMode).toBe(before);
  expect(d.modeChanged).toBe(false);
  expect(d.persistModeState).toBe(false);
  expect(d.status).toEqual({ mode: "plan", borderStyle: "muted" });
  expect(d.error).toBeUndefined();
});

test("transition session_start: cliMode only", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const d = runtime.transition({ type: "session_start", cliMode: "ask" });

  expect(d.nextState.currentMode).toBe("ask");
  expect(d.modeChanged).toBe(true);
  expect(d.persistModeState).toBe(false);
  expect(d.error).toBeUndefined();
});

test("transition session_start: sessionMode only", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const d = runtime.transition({ type: "session_start", sessionMode: "ask" });

  expect(d.nextState.currentMode).toBe("ask");
  expect(d.modeChanged).toBe(true);
  expect(d.persistModeState).toBe(false);
  expect(d.error).toBeUndefined();
});

test("transition session_start: repeated calls idempotent", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  // First call:
  let d = runtime.transition({ type: "session_start", cliMode: "plan" });
  expect(d.nextState.currentMode).toBe("plan");
  expect(d.modeChanged).toBe(true);

  // Second call with same cliMode — mode already matched, no change
  d = runtime.transition({ type: "session_start", cliMode: "plan" });
  expect(d.nextState.currentMode).toBe("plan");
  expect(d.modeChanged).toBe(false);
  expect(d.persistModeState).toBe(false);

  // Third call matching existing state
  d = runtime.transition({ type: "session_start" });
  expect(d.nextState.currentMode).toBe("plan");
  expect(d.modeChanged).toBe(false);
  expect(d.persistModeState).toBe(false);
});
