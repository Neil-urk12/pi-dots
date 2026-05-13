import test from "node:test";
import assert from "node:assert/strict";

import { evaluateToolCall } from "../dist/mode-tool-policy.js";

function decision(input) {
  return evaluateToolCall(input);
}

test("fail-closed blocks mutating tools when mode definition missing", () => {
  const result = decision({ mode: "plan", definition: undefined, toolName: "edit" });
  assert.equal(result.block, true);
  assert.match(result.reason, /fail-closed/);
});

test("fail-closed allows safe read-only bash", () => {
  const result = decision({
    mode: "plan",
    definition: undefined,
    toolName: "bash",
    input: { command: "ls -la" },
  });

  assert.deepEqual(result, { block: false });
});

test("fail-closed blocks unsafe bash", () => {
  const result = decision({
    mode: "plan",
    definition: undefined,
    toolName: "bash",
    input: { command: "git push origin main" },
  });

  assert.equal(result.block, true);
  assert.match(result.reason, /fail-closed blocked unsafe command/);
});

test("enabled_tools allowlist blocks tool before bash policy", () => {
  const result = decision({
    mode: "plan",
    definition: { mode: "plan", enabled_tools: ["read", "bash"], bash_policy: "strict_readonly" },
    toolName: "write",
  });

  assert.equal(result.block, true);
  assert.match(result.reason, /blocks tool: write/);
});

test("strict_readonly blocks non-safelisted bash", () => {
  const result = decision({
    mode: "plan",
    definition: { mode: "plan", enabled_tools: ["bash"], bash_policy: "strict_readonly" },
    toolName: "bash",
    input: { command: "npm test" },
  });

  assert.equal(result.block, true);
  assert.match(result.reason, /Allowed read-only commands only/);
});

test("non_destructive allows development bash", () => {
  const result = decision({
    mode: "code",
    definition: { mode: "code", enabled_tools: ["bash"], bash_policy: "non_destructive" },
    toolName: "bash",
    input: { command: "npm test" },
  });

  assert.deepEqual(result, { block: false });
});

test("non_destructive blocks destructive bash", () => {
  const result = decision({
    mode: "code",
    definition: { mode: "code", enabled_tools: ["bash"], bash_policy: "non_destructive" },
    toolName: "bash",
    input: { command: "rm -rf dist" },
  });

  assert.equal(result.block, true);
  assert.match(result.reason, /blocked destructive command/);
});

test("off policy allows destructive bash when tool is enabled", () => {
  const result = decision({
    mode: "yolo",
    definition: { mode: "yolo", enabled_tools: ["bash"], bash_policy: "off" },
    toolName: "bash",
    input: { command: "git push origin main" },
  });

  assert.deepEqual(result, { block: false });
});

test("mode fallback matrix applies when bash_policy omitted", () => {
  const planResult = decision({
    mode: "plan",
    definition: { mode: "plan", enabled_tools: ["bash"] },
    toolName: "bash",
    input: { command: "npm test" },
  });

  const codeResult = decision({
    mode: "code",
    definition: { mode: "code", enabled_tools: ["bash"] },
    toolName: "bash",
    input: { command: "npm test" },
  });

  assert.equal(planResult.block, true);
  assert.equal(codeResult.block, false);
});
