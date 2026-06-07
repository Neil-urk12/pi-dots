import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  return new Mode(pi, watcher);
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

describe("Mode — discoverAvailableAgents bridge", () => {
  let originalBridge;

  beforeEach(() => {
    originalBridge = globalThis.__pi_subagents;
  });

  afterEach(() => {
    if (originalBridge === undefined) {
      delete globalThis.__pi_subagents;
    } else {
      globalThis.__pi_subagents = originalBridge;
    }
  });

  it("returns [] when the subagent bridge is absent", async () => {
    delete globalThis.__pi_subagents;
    const mode = makeMode();
    await mode.initialize(fakeCtx());
    await mode.evaluateToolCall("bash", { command: "ls" });
    expect(mode.modes().length).toBeGreaterThan(0);
  });

  it("logs a debug message when the subagent bridge throws", async () => {
    globalThis.__pi_subagents = {
      getAgents: () => { throw new Error("bridge broken"); },
    };
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    try {
      const mode = makeMode();
      await mode.initialize(fakeCtx());
      await mode.evaluateToolCall("bash", { command: "ls" });

      expect(debugSpy).toHaveBeenCalled();
      const msg = String(debugSpy.mock.calls[0]?.[0] ?? "");
      expect(msg).toMatch(/bridge|subagent/i);
    } finally {
      debugSpy.mockRestore();
    }
  });
});
