import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Mode, ModeFileWatcher } from "../dist/index.js";

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

function fakeCtx() {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      select: vi.fn().mockResolvedValue(undefined),
      setEditorComponent: vi.fn(),
      theme: { fg: (_s, text) => text, borderColor: (text) => text },
    },
    sessionManager: { getEntries: () => [] },
  };
}

describe("Mode — full session lifecycle", () => {
  it("construct → initialize → captureBaseline → restore → turnEnd", async () => {
    const { mode, pi } = makeMode();
    const ctx = fakeCtx();
    const sessionId = "sess-abc";

    await mode.initialize(ctx, sessionId);
    expect(mode.sessionId()).toBe(sessionId);
    expect(mode.modes().length).toBeGreaterThanOrEqual(5);

    mode.captureBaselineTools(["read", "bash", "write"]);
    expect(mode.activeTools().length).toBe(3);

    mode.restore("plan", undefined);
    expect(mode.currentMode()).toBe("plan");
    expect(pi.setActiveTools).toHaveBeenCalled();

    pi.appendEntry.mockClear();
    mode.turnEnd();
    expect(pi.appendEntry).toHaveBeenCalledWith("mode-state", {
      mode: "plan",
      sessionId: "sess-abc",
    });
  });

  it("dialogs throw before bindContext", async () => {
    const { mode } = makeMode();
    await expect(() => mode.dialogs.confirm("t", "m")).rejects.toThrow(/bindContext/);
  });

  it("effects no-op before bindContext", async () => {
    const { mode, pi } = makeMode();
    mode.setMode("plan");
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });
});

describe("Mode — ModeStatusReader contract", () => {
  it("satisfies currentMode/currentDefinition via structural typing", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const reader = mode;
    expect(typeof reader.currentMode()).toBe("string");
    expect(reader.currentDefinition()).toBeDefined();
    expect(reader.currentDefinition()?.mode).toBe(reader.currentMode());
  });
});

describe("Mode — definition query", () => {
  it("returns definition for any known mode", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    for (const name of mode.modes()) {
      expect(mode.definition(name)?.mode).toBe(name);
    }
  });

  it("returns undefined for unknown mode", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    expect(mode.definition("nonexistent")).toBeUndefined();
  });
});

describe("Mode — setupEditor", () => {
  it("registers editor component via ctx.ui.setEditorComponent", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    mode.setupEditor();
    expect(ctx.ui.setEditorComponent).toHaveBeenCalledTimes(1);
  });

  it("no-op without ctx", () => {
    const { mode } = makeMode();
    expect(() => mode.setupEditor()).not.toThrow();
  });
});
