import { test, expect, vi } from "vitest";

const { mockFn } = vi.hoisted(() => {
  return { mockFn: vi.fn() };
});
vi.mock("fs", async (importActual) => {
  const real = await importActual();
  return {
    ...real,
    promises: new Proxy(real.promises, {
      get(target, prop) {
        if (prop === "stat" && mockFn.getMockImplementation()) return mockFn;
        return Reflect.get(target, prop);
      },
    }),
  };
});
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ModeFileWatcher } from "../dist/index.js";

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-modes-watcher-"));
  const modesDir = join(root, "modes");
  const configPath = join(root, "config.yaml");
  await mkdir(modesDir);
  await writeFile(join(modesDir, "yolo.md"), "---\nmode: yolo\n---\n# YOLO\n");
  await writeFile(join(modesDir, "plan.md"), "---\nmode: plan\n---\n# PLAN\n");
  await writeFile(configPath, "plan:\n  border_label: SAFE\n");
  return { root, modesDir, configPath, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("hasChanges returns false when no files are newer than since", async () => {
  const fx = await makeFixture();
  try {
    const watcher = new ModeFileWatcher(fx.modesDir, fx.configPath);
    const since = Date.now();
    const result = await watcher.hasChanges(since);
    expect(result).toBe(false);
  } finally {
    await fx.cleanup();
  }
});

test("hasChanges returns true when a mode file is newer than since", async () => {
  const fx = await makeFixture();
  try {
    const watcher = new ModeFileWatcher(fx.modesDir, fx.configPath);
    const since = Date.now();
    await setTimeout(10);
    await writeFile(join(fx.modesDir, "plan.md"), "---\nmode: plan\n---\n# UPDATED\n");
    const result = await watcher.hasChanges(since);
    expect(result).toBe(true);
  } finally {
    await fx.cleanup();
  }
});

test("hasChanges returns true when user config is newer than since", async () => {
  const fx = await makeFixture();
  try {
    const watcher = new ModeFileWatcher(fx.modesDir, fx.configPath);
    const since = Date.now();
    await setTimeout(10);
    await writeFile(fx.configPath, "yolo:\n  border_label: FOO\n");
    const result = await watcher.hasChanges(since);
    expect(result).toBe(true);
  } finally {
    await fx.cleanup();
  }
});

test("hasChanges returns false when modesDir does not exist", async () => {
  const fx = await makeFixture();
  try {
    const watcher = new ModeFileWatcher(join(fx.root, "nonexistent"), join(fx.root, "nonexistent.yaml"));
    const result = await watcher.hasChanges(0);
    expect(result).toBe(false);
  } finally {
    await fx.cleanup();
  }
});

test("hasChanges short-circuits on first changed file", async () => {
  const fx = await makeFixture();
  try {
    const watcher = new ModeFileWatcher(fx.modesDir, fx.configPath);
    const since = Date.now();
    await setTimeout(10);
    await writeFile(fx.configPath, "ask:\n  border_label: BAR\n");
    const result = await watcher.hasChanges(since);
    expect(result).toBe(true);
  } finally {
    await fx.cleanup();
  }
});


test("EACCES on modesDir logs error and returns false", async () => {
  const fx = await makeFixture();
  try {
    await chmod(fx.modesDir, 0o000);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const watcher = new ModeFileWatcher(fx.modesDir, fx.configPath);
      const result = await watcher.hasChanges(Date.now() + 100_000);
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toMatch(/EACCES|permission/i);
    } finally {
      consoleSpy.mockRestore();
      await chmod(fx.modesDir, 0o755);
    }
  } finally {
    await fx.cleanup();
  }
});

test("EACCES on userConfigPath logs error and returns false", async () => {
  const fx = await makeFixture();
  try {
    mockFn.mockImplementation(async (p) => {
      const err = new Error(`EACCES: permission denied, stat '${p}'`);
      err.code = "EACCES";
      throw err;
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const watcher = new ModeFileWatcher(fx.modesDir, fx.configPath);
      const result = await watcher.hasChanges(Date.now() + 100_000);
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
      const calls = consoleSpy.mock.calls.flat().join(" ");
      expect(calls).toMatch(/EACCES|permission/i);
    } finally {
      consoleSpy.mockRestore();
      mockFn.mockReset();
    }
  } finally {
    await fx.cleanup();
  }
});

test("ENOENT does NOT log error (silent expected)", async () => {
  const fx = await makeFixture();
  try {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const watcher = new ModeFileWatcher(
        join(fx.root, "nonexistent"),
        join(fx.root, "nonexistent.yaml"),
      );
      const result = await watcher.hasChanges(0);
      expect(result).toBe(false);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  } finally {
    await fx.cleanup();
  }
});
