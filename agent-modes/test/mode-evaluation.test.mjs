import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mode, ModeFileWatcher } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modesDir = path.join(__dirname, "..", "modes");
const userConfigPath = path.join(__dirname, "_nonexistent_user_config.yaml");

function makeMode(toolNames = ["read", "bash", "write", "edit", "Agent"]) {
  const watcher = new ModeFileWatcher(modesDir, userConfigPath);
  const pi = {
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    getAllTools: () => toolNames.map((name) => ({ name })),
    getFlag: () => undefined,
  };
  const mode = new Mode(pi, watcher);
  return { mode, pi };
}

const ALLOW_ONCE_PREFIX = "Allow once";
const SWITCH_PREFIX = "Switch mode";
const DENY = "Deny — block this tool call";

function allowOnceFor(toolName) {
  return `${ALLOW_ONCE_PREFIX} — run "${toolName}" this time without switching mode`;
}

function switchTo(labelFragment) {
  return `${SWITCH_PREFIX} — change to ${labelFragment}`;
}

function fakeCtx({
  confirmReturn = false,
  selectReturns = [],
} = {}) {
  const selectQueue = Array.isArray(selectReturns) ? [...selectReturns] : [selectReturns];
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn().mockResolvedValue(confirmReturn),
      select: vi.fn(async () => selectQueue.shift()),
      setEditorComponent: vi.fn(),
      theme: { fg: (_s, text) => text, borderColor: (text) => text },
    },
    sessionManager: { getEntries: () => [] },
  };
}

describe("Mode — evaluateToolCall: basic allow/block", () => {
  it("allows read in plan mode", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    mode.setMode("plan");
    const result = await mode.evaluateToolCall("read", { path: "foo" });
    expect(result?.block).toBe(false);
  });

  it("blocks write in plan mode", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [DENY] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    const result = await mode.evaluateToolCall("write", { path: "foo" });
    expect(result).toBeDefined();
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/switch to/);
  });

  it("allows everything in yolo mode", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("yolo");
    const result = await mode.evaluateToolCall("write", { path: "foo" });
    expect(result?.block).toBeFalsy();
  });

  it("blocks destructive bash in code mode", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx({ selectReturns: [DENY] }));
    mode.setMode("code");
    const result = await mode.evaluateToolCall("bash", { command: "rm -rf /" });
    expect(result?.block).toBe(true);
  });

  it("allows safe bash in plan mode", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("plan");
    const result = await mode.evaluateToolCall("bash", { command: "ls -la" });
    expect(result?.block).toBe(false);
  });
});

describe("Mode — one-shot bypass", () => {
  it("consumes bypass on second identical call", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [allowOnceFor("write"), DENY] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);

    const first = await mode.evaluateToolCall("write", { path: "foo" });
    expect(first?.block).toBe(false);

    const second = await mode.evaluateToolCall("write", { path: "foo" });
    expect(second?.block).toBe(false);

    const third = await mode.evaluateToolCall("write", { path: "foo" });
    expect(third?.block).toBe(true);
  });

  it("uses full JSON key to avoid collisions", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [allowOnceFor("write"), DENY] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);

    await mode.evaluateToolCall("write", { path: "a" });
    const different = await mode.evaluateToolCall("write", { path: "b" });
    expect(different?.block).toBe(true);
  });

  it("evicts oldest when size cap reached", async () => {
    const { mode } = makeMode();
    const allowMany = Array.from({ length: 105 }, () => allowOnceFor("write"));
    const ctx = fakeCtx({ selectReturns: [...allowMany, DENY] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);

    for (let i = 0; i < 105; i++) {
      await mode.evaluateToolCall("write", { path: `file-${i}`, unique: i });
    }
    const oldest = await mode.evaluateToolCall("write", { path: "file-0", unique: 0 });
    expect(oldest?.block).toBe(true);
  });

  it("clears bypass set on initialize", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [allowOnceFor("write"), DENY] });
    await mode.initialize(ctx, "sess-1");
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);

    await mode.evaluateToolCall("write", { path: "a" });
    const consumed = await mode.evaluateToolCall("write", { path: "a" });
    expect(consumed?.block).toBe(false);

    await mode.initialize(ctx, "sess-2");
    mode.setMode("plan");
    const blocked = await mode.evaluateToolCall("write", { path: "a" });
    expect(blocked?.block).toBe(true);
  });

  it("distinguishes nested object differences in bypass key", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [allowOnceFor("write"), DENY] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);

    await mode.evaluateToolCall("write", { path: "foo", content: { a: "1" } });
    const different = await mode.evaluateToolCall("write", { path: "foo", content: { a: "2" } });
    expect(different?.block).toBe(true);
  });

  it("handles unserializable input without crashing", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [allowOnceFor("write"), allowOnceFor("write")] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);
    const circular = {};
    circular.self = circular;
    const first = await mode.evaluateToolCall("write", circular);
    expect(first?.block).toBe(false);
    const second = await mode.evaluateToolCall("write", circular);
    expect(second?.block).toBe(false);
  });
});

describe("Mode — blocked tool dialog", () => {
  it("switches mode when user picks Switch", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [switchTo("yolo")] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);

    const result = await mode.evaluateToolCall("write", { path: "foo" });
    expect(result?.block).toBe(false);
    expect(mode.currentMode()).toBe("yolo");
  });

  it("denies when user picks Deny", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ selectReturns: [DENY] });
    await mode.initialize(ctx);
    mode.setMode("plan");
    mode.captureBaselineTools(["read", "bash", "write"]);

    const result = await mode.evaluateToolCall("write", { path: "foo" });
    expect(result?.block).toBe(true);
  });

  it("returns block with suggestion text when no ctx", async () => {
    const { mode } = makeMode();
    const { buildModeCatalog } = await import("../dist/index.js");
    const catalogResult = buildModeCatalog({
      modeDocuments: [
        { mode: "plan", parsed: { mode: "plan", bash_policy: "strict_readonly", enabled_tools: ["read", "bash"] } },
        { mode: "code", parsed: { mode: "code" } },
        { mode: "yolo", parsed: { mode: "yolo" } },
        { mode: "ask", parsed: { mode: "ask" } },
        { mode: "orchestrator", parsed: { mode: "orchestrator" } },
      ],
    });
    if (!catalogResult.ok) throw new Error("catalog build failed");

    mode.bindContext({
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        theme: { fg: (_s, t) => t },
      },
      sessionManager: { getEntries: () => [] },
    });
    mode.acceptCatalog(catalogResult.catalog);
    mode.setMode("plan");

    mode.bindContext(undefined);

    const result = await mode.evaluateToolCall("write", { path: "x" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/switch to/);
  });
});

describe("Mode — ask permission dialog", () => {
  it("confirm true returns allow", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ confirmReturn: true });
    await mode.initialize(ctx);

    const catalogResult = (await import("../dist/index.js")).buildModeCatalog({
      modeDocuments: [
        { mode: "plan", parsed: { mode: "plan", permissions: { write: "ask" } } },
        { mode: "code", parsed: { mode: "code" } },
        { mode: "yolo", parsed: { mode: "yolo" } },
        { mode: "ask", parsed: { mode: "ask" } },
        { mode: "orchestrator", parsed: { mode: "orchestrator" } },
      ],
    });
    if (catalogResult.ok) mode.acceptCatalog(catalogResult.catalog);
    mode.setMode("plan");
    const result = await mode.evaluateToolCall("write", { path: "x" });
    expect(result?.block).toBe(false);
  });

  it("confirm false returns block", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({ confirmReturn: false });
    await mode.initialize(ctx);
    const catalogResult = (await import("../dist/index.js")).buildModeCatalog({
      modeDocuments: [
        { mode: "plan", parsed: { mode: "plan", permissions: { write: "ask" } } },
        { mode: "code", parsed: { mode: "code" } },
        { mode: "yolo", parsed: { mode: "yolo" } },
        { mode: "ask", parsed: { mode: "ask" } },
        { mode: "orchestrator", parsed: { mode: "orchestrator" } },
      ],
    });
    if (catalogResult.ok) mode.acceptCatalog(catalogResult.catalog);
    mode.setMode("plan");
    const result = await mode.evaluateToolCall("write", { path: "x" });
    expect(result?.block).toBe(true);
    expect(result?.reason).toMatch(/User denied/);
  });
});
