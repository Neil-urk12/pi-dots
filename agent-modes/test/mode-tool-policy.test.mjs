import { test, expect } from "vitest";

import { evaluateToolCall } from "../dist/index.js";

function decision(input) {
  return evaluateToolCall(input);
}

test("fail-closed blocks mutating tools when mode definition missing", () => {
  const result = decision({ mode: "plan", definition: undefined, toolName: "edit" });
  expect(result.block).toBe(true);
  expect(result.reason).toMatch(/fail-closed/);
});

test("fail-closed allows safe read-only bash", () => {
  const result = decision({
    mode: "plan",
    definition: undefined,
    toolName: "bash",
    input: { command: "ls -la" },
  });

  expect(result).toEqual({ block: false });
});

test("fail-closed blocks unsafe bash", () => {
  const result = decision({
    mode: "plan",
    definition: undefined,
    toolName: "bash",
    input: { command: "git push origin main" },
  });

  expect(result.block).toBe(true);
  expect(result.reason).toMatch(/fail-closed blocked unsafe command/);
});

test("enabled_tools allowlist blocks tool before bash policy", () => {
  const result = decision({
    mode: "plan",
    definition: { mode: "plan", enabled_tools: ["read", "bash"], bash_policy: "strict_readonly" },
    toolName: "write",
  });

  expect(result.block).toBe(true);
  expect(result.reason).toMatch(/blocks tool: write/);
});

test("strict_readonly blocks non-safelisted bash", () => {
  const result = decision({
    mode: "plan",
    definition: { mode: "plan", enabled_tools: ["bash"], bash_policy: "strict_readonly" },
    toolName: "bash",
    input: { command: "npm test" },
  });

  expect(result.block).toBe(true);
  expect(result.reason).toMatch(/Allowed read-only commands only/);
});

test("non_destructive allows development bash", () => {
  const result = decision({
    mode: "code",
    definition: { mode: "code", enabled_tools: ["bash"], bash_policy: "non_destructive" },
    toolName: "bash",
    input: { command: "npm test" },
  });

  expect(result).toEqual({ block: false });
});

test("non_destructive blocks destructive bash", () => {
  const result = decision({
    mode: "code",
    definition: { mode: "code", enabled_tools: ["bash"], bash_policy: "non_destructive" },
    toolName: "bash",
    input: { command: "rm -rf dist" },
  });

  expect(result.block).toBe(true);
  expect(result.reason).toMatch(/blocked destructive command/);
});

test("off policy allows destructive bash when tool is enabled", () => {
  const result = decision({
    mode: "yolo",
    definition: { mode: "yolo", enabled_tools: ["bash"], bash_policy: "off" },
    toolName: "bash",
    input: { command: "git push origin main" },
  });

  expect(result).toEqual({ block: false });
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

  expect(planResult.block).toBe(true);
  expect(codeResult.block).toBe(false);
});

test("curl read-only usage is allowed in strict_readonly", () => {
  const allowed = [
    "curl http://example.com",
    "curl -L http://example.com",
    "curl -I http://example.com",
    "curl -v http://example.com",
    "curl -s http://example.com",
    "curl -sS http://example.com",
    "curl -o - http://example.com",
    "curl -O -",
    "curl -J http://example.com",
    "curl http://example.com/foo-o/bar",
    "curl http://example.com/path-o/file",
    'curl "http://example.com/file-o"',
  ];
  for (const cmd of allowed) {
    const result = decision({
      mode: "plan",
      definition: { mode: "plan", enabled_tools: ["bash"], bash_policy: "strict_readonly" },
      toolName: "bash",
      input: { command: cmd },
    });
    expect(result).toEqual({ block: false }, `curl command should be allowed: ${cmd}`);
  }
});

test("curl file-writing flags are blocked in strict_readonly", () => {
  const blocked = [
    "curl -o file http://example.com",
    "curl -O http://example.com",
    "curl --output file http://example.com",
    "curl --remote-name http://example.com",
    "curl --remote-header-name http://example.com",
    "curl -J -O http://example.com",
    "curl -OJ http://example.com",
    "curl -oA http://example.com",
    "curl -so file http://example.com",
    "curl -sO http://example.com",
    "curl -L -o file http://example.com",
    "curl --create-dirs -o dir/file http://example.com",
  ];
  for (const cmd of blocked) {
    const result = decision({
      mode: "plan",
      definition: { mode: "plan", enabled_tools: ["bash"], bash_policy: "strict_readonly" },
      toolName: "bash",
      input: { command: cmd },
    });
    expect(result.block).toBe(true, `curl command should be blocked: ${cmd}`);
    expect(result.reason).toMatch(/Allowed read-only commands only/);
  }
});
