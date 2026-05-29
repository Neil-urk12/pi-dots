import { describe, it, expect } from "vitest";
import { hasUsage, extractOutputTokens } from "./usage.js";

describe("hasUsage", () => {
  it("returns true for object with usage as non-null object", () => {
    expect(hasUsage({ usage: { output: 1 } })).toBe(true);
  });

  it("returns true for nested message.usage object", () => {
    expect(hasUsage({ usage: {} })).toBe(true);
  });

  it("returns false for null", () => {
    expect(hasUsage(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasUsage(undefined)).toBe(false);
  });

  it("returns false for usage undefined", () => {
    expect(hasUsage({ usage: undefined })).toBe(false);
  });

  it("returns false for usage null", () => {
    expect(hasUsage({ usage: null })).toBe(false);
  });

  it("returns false for usage as primitive", () => {
    expect(hasUsage({ usage: 42 })).toBe(false);
  });

  it("returns false for no usage property", () => {
    expect(hasUsage({})).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(hasUsage("string")).toBe(false);
  });
});

describe("extractOutputTokens", () => {
  it("extracts from top-level usage", () => {
    expect(extractOutputTokens({ usage: { output: 150 } })).toBe(150);
  });

  it("extracts from nested message.usage", () => {
    expect(
      extractOutputTokens({ message: { usage: { output: 200 } } }),
    ).toBe(200);
  });

  it("returns undefined when output is 0 (falsy)", () => {
    expect(extractOutputTokens({ usage: { output: 0 } })).toBeUndefined();
  });

  it("returns undefined for empty usage object", () => {
    expect(extractOutputTokens({ usage: {} })).toBeUndefined();
  });

  it("returns undefined when usage is undefined", () => {
    expect(extractOutputTokens({ usage: undefined })).toBeUndefined();
  });

  it("returns undefined for object with no usage", () => {
    expect(extractOutputTokens({})).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(extractOutputTokens(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(extractOutputTokens(undefined)).toBeUndefined();
  });

  it("returns undefined for negative output", () => {
    expect(extractOutputTokens({ usage: { output: -1 } })).toBeUndefined();
  });

  it("returns fractional tokens", () => {
    expect(extractOutputTokens({ usage: { output: 3.7 } })).toBe(3.7);
  });

  it("prefers top-level usage over nested message.usage", () => {
    expect(
      extractOutputTokens({
        message: { usage: { output: 50 } },
        usage: { output: 100 },
      }),
    ).toBe(100);
  });

  it("returns undefined for Infinity output", () => {
    expect(extractOutputTokens({ usage: { output: Infinity } })).toBeUndefined();
  });

  it("returns undefined for NaN output", () => {
    expect(extractOutputTokens({ usage: { output: NaN } })).toBeUndefined();
  });

  it("returns undefined for string output", () => {
    expect(extractOutputTokens({ usage: { output: "150" } })).toBeUndefined();
  });
});