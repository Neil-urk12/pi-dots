import { describe, it, expect } from "vitest";
import { errorMessage } from "../dist/types.js";

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("converts string to string", () => {
    expect(errorMessage("raw")).toBe("raw");
  });
  it("handles null", () => {
    expect(errorMessage(null)).toBe("null");
  });
});
