import { describe, it, expect } from "vitest";
import fs from "node:fs";

describe("format", () => {
	it("uses consistent 2-tab indentation for message_end callback", () => {
		const content = fs.readFileSync("src/index.ts", "utf-8");
		const lines = content.split("\n");
		const msgEndIf = lines.find(l => l.trim().startsWith("if (agentMsg.role"));
		expect(msgEndIf).toBeDefined();
		expect(msgEndIf!.startsWith("\t\tif")).toBe(true);
	});
});
