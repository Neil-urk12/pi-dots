import { describe, it, expect } from "vitest";
import { normalizeToolLabel } from "./tokLabels.js";

describe("normalizeToolLabel", () => {
	it("maps edit to edit", () => {
		expect(normalizeToolLabel("edit")).toBe("edit");
	});

	it("maps write to write", () => {
		expect(normalizeToolLabel("write")).toBe("write");
	});

	it("maps bash to bash", () => {
		expect(normalizeToolLabel("bash")).toBe("bash");
	});

	it("maps ctx_shell to bash", () => {
		expect(normalizeToolLabel("ctx_shell")).toBe("bash");
	});

	it("maps read to read", () => {
		expect(normalizeToolLabel("read")).toBe("read");
	});

	it("maps ctx_read to read", () => {
		expect(normalizeToolLabel("ctx_read")).toBe("read");
	});

	it("maps gitnexus_detect_changes to nexus", () => {
		expect(normalizeToolLabel("gitnexus_detect_changes")).toBe("nexus");
	});

	it("maps gitnexus_query to nexus", () => {
		expect(normalizeToolLabel("gitnexus_query")).toBe("nexus");
	});

	it("maps context7_get_library_docs to docs", () => {
		expect(normalizeToolLabel("context7_get_library_docs")).toBe("docs");
	});

	it("maps context7_resolve_library_id to docs", () => {
		expect(normalizeToolLabel("context7_resolve_library_id")).toBe("docs");
	});

	it("maps agent_browser to browser", () => {
		expect(normalizeToolLabel("agent_browser")).toBe("browser");
	});

	it("maps Agent to agent", () => {
		expect(normalizeToolLabel("Agent")).toBe("agent");
	});

	it("passes through short unknown names unchanged", () => {
		expect(normalizeToolLabel("grep")).toBe("grep");
	});

	it("truncates long unknown names to 8 chars", () => {
		expect(normalizeToolLabel("some_really_long_tool_name")).toBe("some_rea");
	});

	it("handles empty string", () => {
		expect(normalizeToolLabel("")).toBe("");
	});
});
