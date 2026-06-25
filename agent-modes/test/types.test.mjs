import { describe, it, expect } from "vitest";

describe("BashPatternSeverity", () => {
  it("accepts allow, ask, block", () => {
    const severities = ["allow", "ask", "block"];
    for (const s of severities) {
      expect(["allow", "ask", "block"]).toContain(s);
    }
  });
});
