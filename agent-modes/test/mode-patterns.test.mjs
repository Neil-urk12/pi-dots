import { describe, it, expect } from "vitest";
import { renderPatternsDialog } from "../src/mode-patterns.js";

describe("renderPatternsDialog", () => {
  const mockPatterns = {
    safe: [/^cat/, /^ls/, /^grep/],
    destructive: [/rm/, /sudo/, /git\s+push/],
    safeSource: ["^cat", "^ls", "^grep"],
    destructiveSource: ["rm", "sudo", "git\\s+push"],
    severity: new Map([["sudo", "ask"], ["rm", "allow"]]),
  };
  const mockDefinition = {
    mode: "code",
    bash_policy: "non_destructive",
    bash_patterns: undefined,
  };

  it("returns non-empty options for valid mode", () => {
    const options = renderPatternsDialog({
      mode: "code",
      definition: mockDefinition,
      bashPatterns: mockPatterns,
    });
    expect(options.length).toBeGreaterThan(0);
  });

  it("includes severity count header", () => {
    const options = renderPatternsDialog({
      mode: "code",
      definition: mockDefinition,
      bashPatterns: mockPatterns,
    });
    const header = options[0];
    expect(header).toContain("BLOCK");
    expect(header).toContain("ASK");
    expect(header).toContain("ALLOW");
  });

  it("annotates user-overridden patterns", () => {
    const options = renderPatternsDialog({
      mode: "code",
      definition: mockDefinition,
      bashPatterns: mockPatterns,
      globalBashPatterns: {
        destructive: { severity: { "rm": "allow" } },
      },
    });
    const rmLine = options.find(o => o.includes("rm"));
    expect(rmLine).toContain("←");
  });

  it("shows mode and bash_policy in footer", () => {
    const options = renderPatternsDialog({
      mode: "code",
      definition: mockDefinition,
      bashPatterns: mockPatterns,
    });
    const footerLine = options[options.length - 2];
    expect(footerLine).toContain("code");
    expect(footerLine).toContain("non_destructive");
  });
});
