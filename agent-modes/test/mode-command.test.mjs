import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mode, ModeFileWatcher, buildModeCatalog } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modesDir = path.join(__dirname, "..", "modes");
const userConfigPath = path.join(__dirname, "_nonexistent_user_config.yaml");

function makeMode() {
  const watcher = new ModeFileWatcher(modesDir, userConfigPath);
  const pi = {
    setActiveTools: vi.fn(),
    appendEntry: vi.fn(),
    getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "write" }, { name: "Agent" }],
    getFlag: () => undefined,
  };
  const mode = new Mode(pi, watcher);
  return { mode, pi };
}

function fakeCtx({ selectReturn = undefined } = {}) {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      select: vi.fn().mockResolvedValue(selectReturn),
      setEditorComponent: vi.fn(),
      theme: { fg: (_s, text) => text, borderColor: (text) => text },
    },
    sessionManager: { getEntries: () => [] },
  };
}

describe("Mode — handleCommand", () => {
  it("calls setStatus exactly once when switching mode via command", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    ctx.ui.setStatus.mockClear();
    await mode.handleCommand("plan", async () => undefined);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
  });

  it("calls setStatus exactly once when switching mode via picker", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    ctx.ui.setStatus.mockClear();
    await mode.handleCommand(undefined, async () => "plan");
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
  });

  it("switches mode by name", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    await mode.handleCommand("plan", async () => undefined);
    expect(mode.currentMode()).toBe("plan");
  });

  it("handles 'status' without switching", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    const before = mode.currentMode();
    await mode.handleCommand("status", async () => undefined);
    expect(mode.currentMode()).toBe(before);
    expect(ctx.ui.notify).toHaveBeenCalled();
  });

  it("handles 'reload'", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    await mode.handleCommand("reload", async () => undefined);
    expect(mode.modes().length).toBeGreaterThanOrEqual(5);
  });

  it("uses picker when no args", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    await mode.handleCommand(undefined, async (options) => {
      expect(options.length).toBeGreaterThanOrEqual(5);
      return "plan";
    });
    expect(mode.currentMode()).toBe("plan");
  });

  it("picker returning undefined leaves mode unchanged", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("code");
    await mode.handleCommand(undefined, async () => undefined);
    expect(mode.currentMode()).toBe("code");
  });

  it("notifies error for invalid mode", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    await mode.handleCommand("nonsense", async () => undefined);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/Invalid mode/), "error");
  });
});

describe("Mode — switchMode (public API)", () => {
  it("delegates to setMode", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const result = mode.switchMode("plan");
    expect(result.ok).toBe(true);
    expect(mode.currentMode()).toBe("plan");
  });

  it("rejects overlong names", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const result = mode.switchMode("x".repeat(51));
    expect(result.ok).toBe(false);
  });

  it("rejects empty string", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const result = mode.switchMode("");
    expect(result.ok).toBe(false);
  });
});

describe("Mode — reload", () => {
  it("reload keeps catalog when successful", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    const before = mode.modes();
    await mode.reload();
    expect(mode.modes().length).toBe(before.length);
  });

  it("checkAndReload triggers reload when watcher reports changes", async () => {
    const watcher = { hasChanges: vi.fn().mockResolvedValue(true) };
    const pi = {
      setActiveTools: vi.fn(),
      appendEntry: vi.fn(),
      getAllTools: () => [],
      getFlag: () => undefined,
    };
    const mode = new Mode(pi, watcher);
    await mode.initialize(fakeCtx());
    await mode.checkAndReload();
    expect(watcher.hasChanges).toHaveBeenCalled();
  });

  it("checkAndReload skips when no changes", async () => {
    const watcher = { hasChanges: vi.fn().mockResolvedValue(false) };
    const pi = {
      setActiveTools: vi.fn(),
      appendEntry: vi.fn(),
      getAllTools: () => [],
      getFlag: () => undefined,
    };
    const mode = new Mode(pi, watcher);
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    const notifyCountBefore = ctx.ui.notify.mock.calls.length;
    await mode.checkAndReload();
    expect(ctx.ui.notify.mock.calls.length).toBe(notifyCountBefore);
  });
});

describe("Mode — beforeProviderRequest", () => {
  it("injects prompt suffix into string system", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("plan");
    const payload = { system: "base prompt", messages: [] };
    const out = mode.beforeProviderRequest(payload);
    expect(out.system).toMatch(/MODE: PLAN/);
  });

  it("passes through when no injection needed", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("yolo");
    const payload = { system: "base" };
    const out = mode.beforeProviderRequest(payload);
    expect(out).toBe(payload);
  });
});

describe("Mode — mode switch confirmation (auto_mode_switch)", () => {
  it("skips confirmation when auto_mode_switch true", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);

    const catalogResult = buildModeCatalog({
      modeDocuments: [
        { mode: "yolo", parsed: { mode: "yolo", auto_mode_switch: true } },
        { mode: "plan", parsed: { mode: "plan" } },
        { mode: "code", parsed: { mode: "code" } },
        { mode: "ask", parsed: { mode: "ask" } },
        { mode: "orchestrator", parsed: { mode: "orchestrator" } },
      ],
    });
    if (catalogResult.ok) mode.acceptCatalog(catalogResult.catalog);
    mode.setMode("yolo");

    const def = mode.currentDefinition();
    expect(def?.auto_mode_switch).toBe(true);
    const result = mode.switchMode("plan");
    expect(result.ok).toBe(true);
  });
});
