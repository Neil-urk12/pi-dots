import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ModeFileWatcher } from "../dist/mode-file-watcher.js";

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
    assert.equal(result, false);
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
    assert.equal(result, true);
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
    assert.equal(result, true);
  } finally {
    await fx.cleanup();
  }
});

test("hasChanges returns false when modesDir does not exist", async () => {
  const fx = await makeFixture();
  try {
    const watcher = new ModeFileWatcher(join(fx.root, "nonexistent"), join(fx.root, "nonexistent.yaml"));
    const result = await watcher.hasChanges(0);
    assert.equal(result, false);
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
    assert.equal(result, true);
  } finally {
    await fx.cleanup();
  }
});
