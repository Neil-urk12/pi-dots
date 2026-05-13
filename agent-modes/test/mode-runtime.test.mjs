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
