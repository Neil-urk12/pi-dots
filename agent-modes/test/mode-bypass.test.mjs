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
});
