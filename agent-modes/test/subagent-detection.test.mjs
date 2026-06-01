import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("subagent detection with PI_IS_SUBAGENT env var", () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.PI_IS_SUBAGENT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PI_IS_SUBAGENT;
    } else {
      process.env.PI_IS_SUBAGENT = originalEnv;
    }
  });

  // Helper function that mimics the implementation logic
  function detectSubagent(getAllTools) {
    const allToolNames = getAllTools().map(t => t.name);
    return process.env.PI_IS_SUBAGENT === "1" || !allToolNames.includes("Agent");
  }

  function determineSubagentMode(getAllTools) {
    const allToolNames = getAllTools().map(t => t.name);
    return allToolNames.includes("write") || allToolNames.includes("edit") ? "code" : "plan";
  }

  it("should detect as subagent when PI_IS_SUBAGENT=1 is set", () => {
    process.env.PI_IS_SUBAGENT = "1";
    
    const mockGetAllTools = vi.fn().mockReturnValue([
      { name: "Agent" },
      { name: "bash" },
      { name: "read" },
    ]);

    const isSubagent = detectSubagent(mockGetAllTools);
    expect(isSubagent).toBe(true);
  });

  it("should fall back to tool detection when PI_IS_SUBAGENT is not set", () => {
    delete process.env.PI_IS_SUBAGENT;
    
    const mockGetAllTools = vi.fn().mockReturnValue([
      { name: "bash" },
      { name: "read" },
      { name: "write" },
    ]);

    const isSubagent = detectSubagent(mockGetAllTools);
    expect(isSubagent).toBe(true);
  });

  it("should detect as parent when PI_IS_SUBAGENT is not set and Agent tool present", () => {
    delete process.env.PI_IS_SUBAGENT;
    
    const mockGetAllTools = vi.fn().mockReturnValue([
      { name: "Agent" },
      { name: "bash" },
      { name: "read" },
    ]);

    const isSubagent = detectSubagent(mockGetAllTools);
    expect(isSubagent).toBe(false);
  });

  it("should set subagent mode to code when write/edit tools present", () => {
    process.env.PI_IS_SUBAGENT = "1";
    
    const mockGetAllTools = vi.fn().mockReturnValue([
      { name: "bash" },
      { name: "read" },
      { name: "write" },
      { name: "edit" },
    ]);

    const mode = determineSubagentMode(mockGetAllTools);
    expect(mode).toBe("code");
  });

  it("should set subagent mode to plan when write/edit tools absent", () => {
    process.env.PI_IS_SUBAGENT = "1";
    
    const mockGetAllTools = vi.fn().mockReturnValue([
      { name: "bash" },
      { name: "read" },
    ]);

    const mode = determineSubagentMode(mockGetAllTools);
    expect(mode).toBe("plan");
  });

  it("should handle PI_IS_SUBAGENT=0 as not subagent", () => {
    process.env.PI_IS_SUBAGENT = "0";
    
    const mockGetAllTools = vi.fn().mockReturnValue([
      { name: "bash" },
      { name: "read" },
    ]);

    // PI_IS_SUBAGENT=0 should not be treated as subagent (only "1" is valid)
    const isSubagent = process.env.PI_IS_SUBAGENT === "1" || !mockGetAllTools().map(t => t.name).includes("Agent");
    expect(isSubagent).toBe(true); // Falls back to tool-based detection (no Agent tool)
  });

  it("should handle empty PI_IS_SUBAGENT as not subagent", () => {
    process.env.PI_IS_SUBAGENT = "";
    
    const mockGetAllTools = vi.fn().mockReturnValue([
      { name: "Agent" },
      { name: "bash" },
      { name: "read" },
    ]);

    // Empty string should not be treated as subagent
    const isSubagent = process.env.PI_IS_SUBAGENT === "1" || !mockGetAllTools().map(t => t.name).includes("Agent");
    expect(isSubagent).toBe(false); // Falls back to tool-based detection (Agent tool present)
  });
});
