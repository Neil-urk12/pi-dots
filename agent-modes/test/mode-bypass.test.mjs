import { describe, it, expect } from "vitest";
import { OneShotBypass } from "../src/mode-bypass.ts";

describe("OneShotBypass", () => {
  it("should return false when checkAndConsume is called without a grant", () => {
    const bypass = new OneShotBypass();
    expect(bypass.checkAndConsume("test-tool", { arg: 1 })).toBe(false);
  });

  it("should grant bypass and consume it on first checkAndConsume, returning false on subsequent checks", () => {
    const bypass = new OneShotBypass();
    bypass.grant("test-tool", { arg: 1 });
    expect(bypass.checkAndConsume("test-tool", { arg: 1 })).toBe(true);
    expect(bypass.checkAndConsume("test-tool", { arg: 1 })).toBe(false);
  });

  it("should keep distinct inputs separate and not trigger false positive bypasses", () => {
    const bypass = new OneShotBypass();
    bypass.grant("test-tool", { arg: 1 });
    expect(bypass.checkAndConsume("test-tool", { arg: 2 })).toBe(false);
    expect(bypass.checkAndConsume("test-tool", { arg: 1 })).toBe(true);
  });

  it("should format stable keys for identical objects with different key ordering", () => {
    const bypass = new OneShotBypass();
    bypass.grant("test-tool", { a: 1, b: 2 });
    expect(bypass.checkAndConsume("test-tool", { b: 2, a: 1 })).toBe(true);
  });

  it("should handle nested object serialization correctly", () => {
    const bypass = new OneShotBypass();
    bypass.grant("test-tool", { a: { c: 3, b: 2 } });
    expect(bypass.checkAndConsume("test-tool", { a: { b: 2, c: 3 } })).toBe(true);
  });

  it("should handle circular references or unserializable inputs without throwing, using fallback", () => {
    const bypass = new OneShotBypass();
    const circular = {};
    circular.self = circular;

    bypass.grant("test-tool", circular);
    expect(bypass.checkAndConsume("test-tool", circular)).toBe(true);
  });

  it("should evict oldest entry when maxSize cap is reached", () => {
    const bypass = new OneShotBypass({ maxSize: 3 });
    bypass.grant("tool", { id: 1 });
    bypass.grant("tool", { id: 2 });
    bypass.grant("tool", { id: 3 });
    bypass.grant("tool", { id: 4 }); // should evict "tool:{id:1}"

    expect(bypass.checkAndConsume("tool", { id: 1 })).toBe(false); // evicted
    expect(bypass.checkAndConsume("tool", { id: 2 })).toBe(true);
    expect(bypass.checkAndConsume("tool", { id: 3 })).toBe(true);
    expect(bypass.checkAndConsume("tool", { id: 4 })).toBe(true);
  });

  it("should clear all granted bypasses when clear is called", () => {
    const bypass = new OneShotBypass();
    bypass.grant("tool", { id: 1 });
    bypass.grant("tool", { id: 2 });
    bypass.clear();

    expect(bypass.checkAndConsume("tool", { id: 1 })).toBe(false);
    expect(bypass.checkAndConsume("tool", { id: 2 })).toBe(false);
  });

  it("should grant session-level bypass that allows tool for all calls", () => {
    const bypass = new OneShotBypass();
    bypass.grantSession("bash");

    expect(bypass.checkAndConsume("bash", { command: "ls" })).toBe(true);
    expect(bypass.checkAndConsume("bash", { command: "git status" })).toBe(true);
    expect(bypass.checkAndConsume("write", { path: "test.ts" })).toBe(false);
  });

  it("should not consume session grants — they persist until clear", () => {
    const bypass = new OneShotBypass();
    bypass.grantSession("bash");

    expect(bypass.checkAndConsume("bash", { command: "ls" })).toBe(true);
    expect(bypass.checkAndConsume("bash", { command: "ls" })).toBe(true);
  });

  it("should clear session grants when clear is called", () => {
    const bypass = new OneShotBypass();
    bypass.grantSession("bash");
    expect(bypass.checkAndConsume("bash", { command: "ls" })).toBe(true);

    bypass.clear();
    expect(bypass.checkAndConsume("bash", { command: "ls" })).toBe(false);
  });
});

describe("Prefix bypass (one-shot)", () => {
  it("should grant prefix bypass and match commands starting with the prefix", () => {
    const bypass = new OneShotBypass();
    bypass.grantPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(true);
  });

  it("should grant prefix bypass for multiple calls when using session prefix", () => {
    const bypass = new OneShotBypass();
    bypass.grantSessionPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(true);
    expect(bypass.checkAndConsume("bash", { command: "npm install -g typescript" })).toBe(true);
  });

  it("should not match commands that do not start with the prefix", () => {
    const bypass = new OneShotBypass();
    bypass.grantPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "npm run build" })).toBe(false);
    expect(bypass.checkAndConsume("bash", { command: "git commit" })).toBe(false);
  });

  it("should consume prefix bypass after first match (one-shot)", () => {
    const bypass = new OneShotBypass();
    bypass.grantPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(true);
    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(false);
  });

  it("should be case-sensitive for prefix matching", () => {
    const bypass = new OneShotBypass();
    bypass.grantPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "NPM INSTALL --save" })).toBe(false);
  });

  it("should trim whitespace before matching", () => {
    const bypass = new OneShotBypass();
    bypass.grantPrefix("bash", "  npm install  ");

    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(true);
  });

  it("should trim whitespace in command input before matching", () => {
    const bypass = new OneShotBypass();
    bypass.grantSessionPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "  npm install --save-dev  " })).toBe(true);
  });

  it("should match exact command with prefix grant (not just longer commands)", () => {
    const bypass = new OneShotBypass();
    bypass.grantPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "npm install" })).toBe(true);
  });

  it("should only work for the granted tool", () => {
    const bypass = new OneShotBypass();
    bypass.grantPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("write", { command: "npm install" })).toBe(false);
  });
});

describe("Prefix bypass (session)", () => {
  it("should grant session prefix bypass and persist across calls", () => {
    const bypass = new OneShotBypass();
    bypass.grantSessionPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(true);
    expect(bypass.checkAndConsume("bash", { command: "npm install -g typescript" })).toBe(true);
    expect(bypass.checkAndConsume("bash", { command: "npm install" })).toBe(true);
  });

  it("should not consume session prefix grants (they persist)", () => {
    const bypass = new OneShotBypass();
    bypass.grantSessionPrefix("bash", "npm install");

    bypass.checkAndConsume("bash", { command: "npm install --save-dev" });
    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(true);
  });

  it("should not match non-prefix commands", () => {
    const bypass = new OneShotBypass();
    bypass.grantSessionPrefix("bash", "npm install");

    expect(bypass.checkAndConsume("bash", { command: "npm run build" })).toBe(false);
  });

  it("should clear session prefix grants when clear is called", () => {
    const bypass = new OneShotBypass();
    bypass.grantSessionPrefix("bash", "npm install");

    bypass.clear();
    expect(bypass.checkAndConsume("bash", { command: "npm install --save-dev" })).toBe(false);
  });
});
