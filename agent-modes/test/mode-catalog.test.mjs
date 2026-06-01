import { test, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildModeCatalog, loadAllModes } from "../dist/index.js";

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

  expect(result.ok).toBe(true);
  expect(result.catalog.loadedAt).toBe(456);
  expect([...result.catalog.definitions.keys()].sort()).toEqual([...requiredModes, "review"].sort());
  expect(result.catalog.definitions.get("review").enabled_tools).toEqual(["read"]);
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

  expect(result.ok).toBe(true);
  expect(result.catalog.definitions.get("plan").border_label).toBe(" SAFE ");
  expect(result.catalog.definitions.get("plan").border_style).toBe("custom-style");
  expect(result.diagnostics.map(d => d.message).join("\n")).toMatch(/Unknown user override ignored: unknown/);
  expect(result.diagnostics.map(d => d.message).join("\n")).toMatch(/User override for 'ask' must be an object/);
});

test("loads required built-ins plus extra markdown modes", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "review.md"), `---\nmode: review\nenabled_tools:\n  - read\ndescription: Review\nborder_style: accent\n---\n# Review\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath, now: () => 123 });
    expect(result.ok).toBe(true);
    expect(result.catalog.loadedAt).toBe(123);
    expect([...result.catalog.definitions.keys()].sort()).toEqual([...requiredModes, "review"].sort());
  } finally {
    await fx.cleanup();
  }
});

test("fails closed when required built-in is missing", async () => {
  const fx = await makeFixture();
  try {
    await rm(join(fx.modesDir, "plan.md"));
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(d => d.message).join("\n")).toMatch(/Required built-in mode missing: plan/);
  } finally {
    await fx.cleanup();
  }
});

test("applies user overrides only to existing modes", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(fx.userConfigPath, `plan:\n  border_label: " SAFE "\nunknown:\n  border_label: " NOPE "\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(true);
    expect(result.catalog.definitions.get("plan").border_label).toBe(" SAFE ");
    expect(result.catalog.definitions.has("unknown")).toBe(false);
    expect(result.diagnostics.map(d => d.message).join("\n")).toMatch(/Unknown user override ignored: unknown/);
  } finally {
    await fx.cleanup();
  }
});

test("invalid extra mode is warning, not catalog failure", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "bad.md"), `---\nmode: wrong\n---\n# Bad\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(true);
    expect(result.catalog.definitions.has("bad")).toBe(false);
    expect(result.diagnostics.map(d => d.message).join("\n")).toMatch(/Mode 'bad' load error/);
  } finally {
    await fx.cleanup();
  }
});

// --- YAML deserialization security tests ---

test("loadAllModes rejects !!js/function tags in mode frontmatter (no code execution)", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "plan.md"), `---\nmode: plan\nenabled_tools: []\ndescription: !!js/function "return 'pwned'"\nborder_style: muted\n---\n# plan\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(false);
  } finally {
    await fx.cleanup();
  }
});

test("loadAllModes rejects !!js/regexp tags in mode frontmatter", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "plan.md"), `---\nmode: plan\nenabled_tools: []\ndescription: !!js/regexp /malicious/i\nborder_style: muted\n---\n# plan\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(false);
  } finally {
    await fx.cleanup();
  }
});

test("user config with !!js/function tags does not execute arbitrary code", async () => {
  const fx = await makeFixture();
  try {
    const maliciousPayload = [
      "plan:",
      `  description: !!js/function "(function() { globalThis.__PI_TEST_PWNED = true; return 'pwned'; })"`,
    ].join("\n");
    await writeFile(fx.userConfigPath, maliciousPayload);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(globalThis.__PI_TEST_PWNED).toBeUndefined();
    delete globalThis.__PI_TEST_PWNED;
    const def = result.catalog.definitions.get("plan");
    expect(typeof def.description).not.toBe("function");
  } finally {
    delete globalThis.__PI_TEST_PWNED;
    await fx.cleanup();
  }
});

test("loadAllModes handles malformed YAML syntax gracefully", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "plan.md"), `---\nmode: plan\ndescription: |\n  unclosed block\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some(d => d.message.includes("plan"))).toBe(true);
  } finally {
    await fx.cleanup();
  }
});

test("loadAllModes rejects !!python/object tags in mode frontmatter", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "plan.md"), `---\nmode: plan\nenabled_tools: []\ndescription: !!python/object/apply:os.system ["echo pwned"]\nborder_style: muted\n---\n# plan\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(false);
  } finally {
    await fx.cleanup();
  }
});

test("loadAllModes rejects arbitrary unknown !! tags", async () => {
  const fx = await makeFixture();
  try {
    await writeFile(join(fx.modesDir, "plan.md"), `---\nmode: plan\nenabled_tools: []\ndescription: !!custom/tag "payload"\nborder_style: muted\n---\n# plan\n`);
    const result = await loadAllModes({ modesDir: fx.modesDir, userConfigPath: fx.userConfigPath });
    expect(result.ok).toBe(false);
  } finally {
    await fx.cleanup();
  }
});

// --- validateBashPatternConfig tests (via buildModeCatalog) ---

// Helper: build catalog with all required modes + test-specific code mode with bash_patterns
function buildWithBashPatterns(bashPatterns) {
  return buildModeCatalog({
    modeDocuments: [
      ...parsedRequiredModes().filter(d => d.mode !== "code"),
      parsedMode("code", { mode: "code", bash_patterns: bashPatterns }),
    ],
    fileForMode: (mode) => `/modes/${mode}.md`,
  });
}

test("valid bash_patterns with safe and destructive returns structured object", () => {
  const result = buildWithBashPatterns({
    safe: { add: ["pattern1"] },
    destructive: { remove: ["pattern2"] },
  });

  expect(result.ok).toBe(true);
  const def = result.catalog.definitions.get("code");
  expect(def.bash_patterns).toEqual({
    safe: { add: ["pattern1"] },
    destructive: { remove: ["pattern2"] },
  });
});

test("valid bash_patterns with only safe — destructive absent", () => {
  const result = buildWithBashPatterns({ safe: { add: ["git status"] } });

  expect(result.ok).toBe(true);
  const def = result.catalog.definitions.get("code");
  expect(def.bash_patterns.safe).toEqual({ add: ["git status"] });
  expect(def.bash_patterns.destructive).toBeUndefined();
});

test("valid bash_patterns with only destructive — safe absent", () => {
  const result = buildWithBashPatterns({ destructive: { add: ["rm"] } });

  expect(result.ok).toBe(true);
  const def = result.catalog.definitions.get("code");
  expect(def.bash_patterns.safe).toBeUndefined();
  expect(def.bash_patterns.destructive).toEqual({ add: ["rm"] });
});

test("empty bash_patterns object returns empty config", () => {
  const result = buildWithBashPatterns({});

  expect(result.ok).toBe(true);
  const def = result.catalog.definitions.get("code");
  expect(def.bash_patterns).toEqual({});
});

test("undefined bash_patterns passes through as undefined", () => {
  const result = buildModeCatalog({
    modeDocuments: parsedRequiredModes(),
    fileForMode: (mode) => `/modes/${mode}.md`,
  });

  expect(result.ok).toBe(true);
  const def = result.catalog.definitions.get("code");
  expect(def.bash_patterns).toBeUndefined();
});

test("non-object bash_patterns (null, string, number, boolean) returns undefined — mode loads", () => {
  for (const bad of [null, "string", 42, true]) {
    const result = buildWithBashPatterns(bad);

    // validateBashPatternConfig returns undefined for non-objects; mode loads normally
    expect(result.ok).toBe(true);
    const def = result.catalog.definitions.get("code");
    expect(def.bash_patterns).toBeUndefined();
  }
});

test("bash_patterns.safe as non-object (array) throws — mode skipped", () => {
  const result = buildWithBashPatterns({ safe: ["not", "an", "object"] });

  // code mode skipped due to validation error; missing required mode = ok:false
  expect(result.ok).toBe(false);
  expect(result.diagnostics.some(d => d.message.includes("safe must be an object"))).toBe(true);
});

test("bash_patterns.destructive as non-object throws — mode skipped", () => {
  const result = buildWithBashPatterns({ destructive: 123 });

  expect(result.ok).toBe(false);
  expect(result.diagnostics.some(d => d.message.includes("destructive must be an object"))).toBe(true);
});

test("bash_patterns.safe.add as non-array throws — mode skipped", () => {
  const result = buildWithBashPatterns({ safe: { add: "not-array" } });

  expect(result.ok).toBe(false);
  expect(result.diagnostics.some(d => d.message.includes("safe.add must be an array of strings"))).toBe(true);
});

test("bash_patterns.safe.remove as non-string-array throws — mode skipped", () => {
  const result = buildWithBashPatterns({ safe: { remove: [1, 2] } });

  expect(result.ok).toBe(false);
  expect(result.diagnostics.some(d => d.message.includes("safe.remove must be an array of strings"))).toBe(true);
});

test("valid bash_patterns with both add and remove on same key", () => {
  const result = buildWithBashPatterns({
    safe: { add: ["git status", "ls"], remove: ["pattern-x"] },
    destructive: { add: ["rm -rf"], remove: ["pattern-y"] },
  });

  expect(result.ok).toBe(true);
  const def = result.catalog.definitions.get("code");
  expect(def.bash_patterns.safe.add).toEqual(["git status", "ls"]);
  expect(def.bash_patterns.safe.remove).toEqual(["pattern-x"]);
  expect(def.bash_patterns.destructive.add).toEqual(["rm -rf"]);
  expect(def.bash_patterns.destructive.remove).toEqual(["pattern-y"]);
});