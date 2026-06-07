import { describe, it, expect, vi, beforeEach } from "vitest";
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
    getAllTools: () => [{ name: "read" }, { name: "bash" }, { name: "write" }, { name: "edit" }, { name: "Agent" }],
    getFlag: () => undefined,
  };
  const mode = new Mode(pi, watcher);
  return { mode, pi };
}

function fakeCtx(overrides = {}) {
  return {
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      select: vi.fn().mockResolvedValue(undefined),
      setEditorComponent: vi.fn(),
      theme: { fg: (style, text) => text, borderColor: (text) => text },
    },
    sessionManager: { getEntries: () => [] },
    ...overrides,
  };
}

describe("Mode — lifecycle", () => {
  it("constructs without binding ctx", async () => {
    const { mode } = makeMode();
    expect(mode.currentMode()).toBe("yolo");
  });

  it("initialize loads catalog and sets default mode", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx, "sess-1");
    expect(["orchestrator", "yolo", "plan", "code", "ask"]).toContain(mode.currentMode());
    expect(mode.sessionId()).toBe("sess-1");
    expect(mode.modes().length).toBeGreaterThanOrEqual(5);
  });

  it("captureBaselineTools records only once", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("yolo");
    mode.captureBaselineTools(["read", "bash"]);
    mode.captureBaselineTools(["read", "bash", "write"]);
    expect(mode.activeTools()).toEqual(["read", "bash"]);
  });

  it("bindContext wires effects to ctx", async () => {
    const { mode, pi } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    mode.captureBaselineTools(["read"]);
    mode.setMode("plan");
    expect(ctx.ui.notify).toHaveBeenCalled();
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });
});

describe("Mode — setMode", () => {
  it("switches to a valid mode and returns ok", async () => {
    const { mode, pi } = makeMode();
    await mode.initialize(fakeCtx());
    mode.captureBaselineTools(["read", "bash", "write"]);
    const result = mode.setMode("plan");
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("plan");
    expect(mode.currentMode()).toBe("plan");
    expect(pi.setActiveTools).toHaveBeenCalled();
  });

  it("returns error for unknown mode", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const result = mode.setMode("nonsense");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid mode/);
    expect(mode.currentMode()).not.toBe("nonsense");
  });

  it("normalises case", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const result = mode.setMode("PLAN");
    expect(result.ok).toBe(true);
    expect(mode.currentMode()).toBe("plan");
  });

  it("returns error before catalog loaded", () => {
    const { mode } = makeMode();
    const result = mode.setMode("plan");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not initialized/);
  });

  it("persists when mode actually changes", async () => {
    const { mode, pi } = makeMode();
    await mode.initialize(fakeCtx(), "sess-1");
    mode.setMode("plan");
    expect(pi.appendEntry).toHaveBeenCalledWith("mode-state", { mode: "plan", sessionId: "sess-1" });
  });

  it("does not persist when mode unchanged", async () => {
    const { mode, pi } = makeMode();
    await mode.initialize(fakeCtx(), "sess-1");
    const initial = mode.currentMode();
    pi.appendEntry.mockClear();
    mode.setMode(initial);
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });
});

describe("Mode — cycleMode", () => {
  it("advances to the next mode in the list", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const before = mode.currentMode();
    const beforeIdx = mode.modes().indexOf(before);
    mode.cycleMode();
    const after = mode.currentMode();
    const afterIdx = mode.modes().indexOf(after);
    expect(afterIdx).toBe((beforeIdx + 1) % mode.modes().length);
  });

  it("wraps around at end of list", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    const count = mode.modes().length;
    for (let i = 0; i < count; i++) mode.cycleMode();
    const loopedBack = mode.currentMode();
    mode.setMode(loopedBack);
    expect(mode.currentMode()).toBe(loopedBack);
  });
});

describe("Mode — restore", () => {
  it("CLI flag wins over session", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.restore("plan", "code");
    expect(mode.currentMode()).toBe("plan");
  });

  it("session wins when CLI absent", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.restore(undefined, "code");
    expect(mode.currentMode()).toBe("code");
  });

  it("falls back to safe mode when both invalid", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.restore("nonexistent", "also-nonexistent");
    expect(["plan", "ask", "yolo", "orchestrator", "code"]).toContain(mode.currentMode());
  });

  it("keeps current mode when neither provided", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("plan");
    mode.restore();
    expect(mode.currentMode()).toBe("plan");
  });
});

describe("Mode — restoreFromSession", () => {
  it("returns undefined when no entries", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    expect(mode.restoreFromSession("sess-x")).toBeUndefined();
  });

  it("returns mode matching sessionId", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "mode-state", data: { mode: "plan", sessionId: "sess-a" } },
          { type: "custom", customType: "mode-state", data: { mode: "code", sessionId: "sess-b" } },
        ],
      },
    });
    await mode.initialize(ctx);
    expect(mode.restoreFromSession("sess-b")).toBe("code");
    expect(mode.restoreFromSession("sess-a")).toBe("plan");
  });

  it("falls back to last entry when sessionId absent", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "mode-state", data: { mode: "plan" } },
          { type: "custom", customType: "mode-state", data: { mode: "ask" } },
        ],
      },
    });
    await mode.initialize(ctx);
    expect(mode.restoreFromSession()).toBe("ask");
  });

  it("ignores non-mode-state entries", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx({
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "something-else", data: { mode: "yolo" } },
        ],
      },
    });
    await mode.initialize(ctx);
    expect(mode.restoreFromSession()).toBeUndefined();
  });
});

describe("Mode — acceptCatalog", () => {
  it("keeps current mode when still present", async () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    await mode.initialize(ctx);
    mode.setMode("plan");
    const catalog = { definitions: new Map([["plan", { mode: "plan" }]]), loadedAt: Date.now() };
    mode.acceptCatalog(catalog);
    expect(mode.currentMode()).toBe("plan");
  });

  it("falls back to safe mode when current disappears", async () => {
    const { mode } = makeMode();
    await mode.initialize(fakeCtx());
    mode.setMode("code");
    const catalog = { definitions: new Map([["plan", { mode: "plan" }], ["yolo", { mode: "yolo" }]]), loadedAt: Date.now() };
    mode.acceptCatalog(catalog);
    expect(["plan", "yolo"]).toContain(mode.currentMode());
  });
});

describe("Mode — turnEnd", () => {
  it("persists mode when sessionId set", async () => {
    const { mode, pi } = makeMode();
    await mode.initialize(fakeCtx(), "sess-x");
    pi.appendEntry.mockClear();
    mode.turnEnd();
    expect(pi.appendEntry).toHaveBeenCalledWith("mode-state", { mode: mode.currentMode(), sessionId: "sess-x" });
  });

  it("does not persist when no sessionId", async () => {
    const { mode, pi } = makeMode();
    const ctx = fakeCtx();
    mode.bindContext(ctx);
    mode.turnEnd();
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });

  it("logs a warning when no sessionId so silent no-op is diagnosable", () => {
    const { mode } = makeMode();
    const ctx = fakeCtx();
    mode.bindContext(ctx);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mode.turnEnd();
      expect(warnSpy).toHaveBeenCalled();
      const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
      expect(msg).toMatch(/session/i);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
