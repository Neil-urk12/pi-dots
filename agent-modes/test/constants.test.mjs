import { describe, it, expect } from "vitest";
import { DEFAULT_MODE, SAFE_FALLBACK_MODES, PICKER_FALLBACK_MODE, MAX_MODE_NAME_LENGTH, SUFFIX_PREVIEW_LENGTH } from "../dist/index.js";

describe("shared constants", () => {
  it("DEFAULT_MODE is orchestrator", () => { expect(DEFAULT_MODE).toBe("orchestrator"); });
  it("SAFE_FALLBACK_MODES includes plan, ask, yolo", () => { expect(SAFE_FALLBACK_MODES).toEqual(["plan", "ask", "yolo"]); });
  it("PICKER_FALLBACK_MODE is yolo", () => { expect(PICKER_FALLBACK_MODE).toBe("yolo"); });
  it("MAX_MODE_NAME_LENGTH is 50", () => { expect(MAX_MODE_NAME_LENGTH).toBe(50); });
  it("SUFFIX_PREVIEW_LENGTH is 120", () => { expect(SUFFIX_PREVIEW_LENGTH).toBe(120); });
});
