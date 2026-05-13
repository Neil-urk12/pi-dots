import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModeCatalog, loadAllModes } from "../dist/mode-catalog.js";

const requiredModes = ["yolo", "plan", "code", "ask", "orchestrator"];

function parsedMode(mode, overrides = {}) {
  return {
    mode,
    file: `${mode}.md`,
    parsed: {
      mode,
      enabled_tools: [],
      description: mode,
      border_style: "muted",
      prompt_suffix: "",
      ...overrides,
    },
  };
}

function parsedRequiredModes() {
  return requiredModes.map((mode) => parsedMode(mode));
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-modes-catalog-"));
  const modesDir = join(root, "modes");
  await mkdir(modesDir);
  for (const mode of requiredModes) {
    await writeFile(join(modesDir, `${mode}.md`), `---\nmode: ${mode}\nenabled_tools: []\ndescription: ${mode}\nborder_label: " ${mode.toUpperCase()} "\nborder_style: muted\nprompt_suffix: ""\n---\n# ${mode}\n`);
  }
  return { root, modesDir, userConfigPath: join(root, "config.yaml"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("buildModeCatalog builds catalog from parsed documents without file system", () => {
  const result = buildModeCatalog({
    modeDocuments: [...parsedRequiredModes(), parsedMode("review", { enabled_tools: ["read"] })],
    fileForMode: (mode) => `/modes/${mode}.md`,
    now: () => 456,
  });

  assert.equal(result.ok, true);
  assert.equal(result.catalog.loadedAt, 456);
  assert.deepEqual([...result.catalog.definitions.keys()].sort(), [...requiredModes, "review"].sort());
  assert.deepEqual(result.catalog.definitions.get("review").enabled_tools, ["read"]);
});

test("buildModeCatalog preserves current permissive user override semantics", () => {
  const result = buildModeCatalog({
    modeDocuments: parsedRequiredModes(),
    userOverrides: {
      file: "config.yaml",
      parsed: {
        plan: { border_label: " SAFE ", border_style: "custom-style" },
        ask: [],
        unknown: { border_label: " NOPE " },
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.catalog.definitions.get("plan").border_label, " SAFE ");
  assert.equal(result.catalog.definitions.get("plan").border_style, "custom-style");
  assert.match(result.diagnostics.map(d => d.message).join("\n"), /Unknown user override ignored: unknown/);
  assert.match(result.diagnostics.map(d => d.message).join("\n"), /User override for 'ask' must be an object/);
});

test("loads required built-ins plus extra markdown modes", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "review.md"), `---\nmode: review\nenabled_tools:\n  - read\ndescription: Review\nborder_style: accent\n---\n# Review\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath, now: () => 123 });
    assert.equal(result.ok, true);
    assert.equal(result.catalog.loadedAt, 123);
    assert.deepEqual([...result.catalog.definitions.keys()].sort(), [...requiredModes, "review"].sort());
  } finally {
    await fx.cleanup();
  }
});

test("fails closed when required built-in is missing", async () => {
  const fx = await makeFixture();
  try {
    await rm(join(fx.modesDir, "plan.md"));
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    assert.equal(result.ok, false);
    assert.match(result.diagnostics.map(d => d.message).join("\n"), /Required built-in mode missing: plan/);
  } finally {
    await fx.cleanup();
  }
});

test("applies user overrides only to existing modes", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(fx.userConfigPath, `plan:\n  border_label: " SAFE "\nunknown:\n  border_label: " NOPE "\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    assert.equal(result.ok, true);
    assert.equal(result.catalog.definitions.get("plan").border_label, " SAFE ");
    assert.equal(result.catalog.definitions.has("unknown"), false);
    assert.match(result.diagnostics.map(d => d.message).join("\n"), /Unknown user override ignored: unknown/);
  } finally {
    await fx.cleanup();
  }
});

test("invalid extra mode is warning, not catalog failure", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "bad.md"), `---\nmode: wrong\n---\n# Bad\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    assert.equal(result.ok, true);
    assert.equal(result.catalog.definitions.has("bad"), false);
    assert.match(result.diagnostics.map(d => d.message).join("\n"), /Mode 'bad' load error/);
  } finally {
    await fx.cleanup();
  }
});
