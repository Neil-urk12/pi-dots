import test from "node:test";
import assert from "node:assert/strict";
import { ModeRuntimeController } from "../dist/mode-runtime.js";

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

  assert.equal(runtime.snapshot().currentMode, "plan");
  assert.deepEqual(effects.activeTools, ["read", "bash"]);
  assert.equal(effects.persist, false);
});

test("restore ignores invalid CLI and uses session mode", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));

  runtime.restore({ cliMode: "missing", sessionMode: "ask" });

  assert.equal(runtime.snapshot().currentMode, "ask");
});

test("setMode rejects unknown mode", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));

  const result = runtime.setMode("missing");

  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid mode: missing/);
  assert.equal(runtime.snapshot().currentMode, "yolo");
});

test("setMode updates mode and marks persistence", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const result = runtime.setMode("plan");

  assert.equal(result.ok, true);
  assert.equal(runtime.snapshot().currentMode, "plan");
  assert.equal(result.effects.persist, true);
  assert.deepEqual(result.effects.activeTools, ["read", "bash"]);
});

test("failed reload keeps known-good catalog", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"], 10));
  runtime.setMode("plan");

  const result = runtime.keepCatalog();

  assert.equal(result.accepted, false);
  assert.equal(runtime.snapshot().currentMode, "plan");
  assert.deepEqual(runtime.modes(), ["yolo", "plan"]);
  assert.equal(runtime.lastLoadTime(), 10);
});

test("successful reload missing current mode falls back to plan first", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "code"]));
  runtime.setMode("code");

  const result = runtime.acceptCatalog(catalog(["yolo", "plan", "ask"], 20));

  assert.equal(result.accepted, true);
  assert.equal(result.fallbackMode, "plan");
  assert.equal(runtime.snapshot().currentMode, "plan");
  assert.equal(runtime.lastLoadTime(), 20);
});

test("empty enabled_tools uses baseline tools", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  assert.deepEqual(runtime.activeTools(), ["read", "bash", "edit"]);
});

// --- Priority tests for single transition() entry point ---

test("transition session_start: CLI mode wins over session mode", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const d = runtime.transition({ type: "session_start", cliMode: "plan", sessionMode: "ask" });

  assert.equal(d.nextState.currentMode, "plan");
  assert.equal(d.modeChanged, true);
  assert.equal(d.persistModeState, false);
  assert.deepEqual(d.activeTools, ["read", "bash"]);
  assert.equal(d.error, undefined);
});

test("transition mode_reload_result: missing mode falls back plan→ask→yolo", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "code", "orchestrator"]));
  runtime.setMode("code");

  // Reload with catalog missing code — fallback to plan (highest fallback)
  const d = runtime.transition({
    type: "mode_reload_result",
    catalog: catalog(["yolo", "plan", "ask"], 20),
  });

  assert.equal(d.acceptedCatalog, true);
  assert.equal(d.fallbackMode, "plan");
  assert.equal(d.modeChanged, true);
  assert.equal(d.persistModeState, true);
  assert.equal(d.nextState.currentMode, "plan");
  assert.equal(d.notifications.length, 1);
  assert.match(d.notifications[0].message, /fell back to PLAN/);
});

test("transition mode_reload_result: cascade when plan not available either", () => {
  const runtime = new ModeRuntimeController(catalog(["ask", "yolo", "orchestrator"]));
  runtime.setMode("orchestrator");

  // Reload: orchestrator gone, plan not in catalog, ask is next fallback
  const d = runtime.transition({
    type: "mode_reload_result",
    catalog: catalog(["ask", "yolo"], 20),
  });

  assert.equal(d.fallbackMode, "ask");
  assert.equal(d.nextState.currentMode, "ask");
});

test("transition turn_end: sets persistModeState true", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  const d = runtime.transition({ type: "turn_end" });

  assert.equal(d.persistModeState, true);
  assert.equal(d.modeChanged, false);
});

test("repeated transitions: no state thrash across cycle", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit", "grep", "find"]);

  // session_start → tool_call → turn_end → tool_call → turn_end
  let d = runtime.transition({ type: "session_start" });
  assert.equal(d.nextState.currentMode, "yolo");
  // First turn_end should persist (records current mode)
  d = runtime.transition({ type: "turn_end" });
  assert.equal(d.persistModeState, true);
  assert.equal(d.modeChanged, false);

  // Simulate mode switch
  d = runtime.transition({ type: "mode_select", requestedMode: "plan" });
  assert.equal(d.modeChanged, true);
  assert.equal(d.persistModeState, true);

  // turn_end with mode=plan still persists (no duplicate writes)
  d = runtime.transition({ type: "turn_end" });
  assert.equal(d.persistModeState, true);
  assert.equal(d.modeChanged, false);

  // tool_call doesn't persist
  d = runtime.transition({ type: "tool_call" });
  assert.equal(d.persistModeState, false);

  // turn_end after tool_call still persists
  d = runtime.transition({ type: "turn_end" });
  assert.equal(d.persistModeState, true);
});

test("transition mode_select: error via decision not exception", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  const d = runtime.transition({ type: "mode_select", requestedMode: "bogus" });

  assert(d.error);
  assert.match(d.error, /Invalid mode/);
  assert.equal(d.modeChanged, false);
  assert.equal(d.persistModeState, false);
  // Current mode unchanged
  assert.equal(runtime.snapshot().currentMode, "yolo");
});

test("transition mode_cycle: wraps around", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.setMode("plan");

  const d = runtime.transition({ type: "mode_cycle" });
  assert.equal(d.nextState.currentMode, "ask");
  assert.equal(d.modeChanged, true);
  assert.equal(d.persistModeState, true);
});

test("transition tool_call: no state change", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan"]));
  runtime.setMode("plan");

  const before = runtime.snapshot().currentMode;
  const d = runtime.transition({ type: "tool_call", toolName: "read" });

  assert.equal(d.nextState.currentMode, before);
  assert.equal(d.modeChanged, false);
  assert.equal(d.persistModeState, false);
  assert.deepEqual(d.status, { mode: "plan", borderStyle: "muted" });
  assert.equal(d.error, undefined);
});

test("transition session_start: cliMode only", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const d = runtime.transition({ type: "session_start", cliMode: "ask" });

  assert.equal(d.nextState.currentMode, "ask");
  assert.equal(d.modeChanged, true);
  assert.equal(d.persistModeState, false);
  assert.equal(d.error, undefined);
});

test("transition session_start: sessionMode only", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  const d = runtime.transition({ type: "session_start", sessionMode: "ask" });

  assert.equal(d.nextState.currentMode, "ask");
  assert.equal(d.modeChanged, true);
  assert.equal(d.persistModeState, false);
  assert.equal(d.error, undefined);
});

test("transition session_start: repeated calls idempotent", () => {
  const runtime = new ModeRuntimeController(catalog(["yolo", "plan", "ask"]));
  runtime.captureBaselineTools(["read", "bash", "edit"]);

  // First call:
  let d = runtime.transition({ type: "session_start", cliMode: "plan" });
  assert.equal(d.nextState.currentMode, "plan");
  assert.equal(d.modeChanged, true);

  // Second call with same cliMode — mode already matched, no change
  d = runtime.transition({ type: "session_start", cliMode: "plan" });
  assert.equal(d.nextState.currentMode, "plan");
  assert.equal(d.modeChanged, false);
  assert.equal(d.persistModeState, false);

  // Third call matching existing state
  d = runtime.transition({ type: "session_start" });
  assert.equal(d.nextState.currentMode, "plan");
  assert.equal(d.modeChanged, false);
  assert.equal(d.persistModeState, false);
});
