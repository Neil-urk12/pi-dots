import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadMarkdownAgents,
	parseMarkdownAgent,
	type ParsedMarkdownAgent,
} from "../markdown-agent.ts";

const mkdtemp = (prefix: string): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), prefix));

const writeFile = (filePath: string, content: string): Promise<void> =>
	fs.writeFile(filePath, content, "utf-8");

const rm = (dir: string): Promise<void> => fs.rm(dir, { recursive: true, force: true });

describe("parseMarkdownAgent", () => {
	const FILE = "agents/blitz.md";

	test("parses a well-formed file with all frontmatter fields", () => {
		const content = `---
name: blitz
role: scout
description: Local codebase recon
model: anthropic/claude-sonnet-4-5
task: Recon the repo
---
You explore the repo. Cite paths.`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(false);
		if ("error" in result) return;

		const agent: ParsedMarkdownAgent = result;
		expect(agent.name).toBe("blitz");
		expect(agent.role).toBe("scout");
		expect(agent.description).toBe("Local codebase recon");
		expect(agent.model).toBe("anthropic/claude-sonnet-4-5");
		expect(agent.task).toBe("Recon the repo");
		expect(agent.instructions).toBe("You explore the repo. Cite paths.");
		expect(agent.sourceFile).toBe(FILE);
	});

	test("returns error when name is missing", () => {
		const content = `---
role: scout
task: Recon the repo
---
Body`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(true);
		if (!("error" in result)) return;
		expect(result.error.toLowerCase()).toContain("name");
	});

	test("returns error when role is missing", () => {
		const content = `---
name: blitz
task: Recon the repo
---
Body`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(true);
		if (!("error" in result)) return;
		expect(result.error.toLowerCase()).toContain("role");
	});

	test("returns error when task is missing", () => {
		const content = `---
name: blitz
role: scout
---
Body`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(true);
		if (!("error" in result)) return;
		expect(result.error.toLowerCase()).toContain("task");
	});

	test("returns error when role contains whitespace (two words)", () => {
		const content = `---
name: blitz
role: two words
task: Recon the repo
---
Body`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(true);
		if (!("error" in result)) return;
		expect(result.error.toLowerCase()).toContain("role");
	});

	test("returns error on bad YAML in frontmatter", () => {
		const content = `---
name: blitz
role: [unclosed
task: Recon
---
Body`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(true);
		if (!("error" in result)) return;
		// Either YAML parser error or "missing" (depending on what the parser returns)
		expect(result.error.length).toBeGreaterThan(0);
	});

	test("returns error when frontmatter is missing entirely", () => {
		const content = `# Just a heading

No frontmatter here.`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(true);
		if (!("error" in result)) return;
		expect(result.error.toLowerCase()).toContain("frontmatter");
	});

	test("returns empty instructions when body is empty", () => {
		const content = `---
name: blitz
role: scout
task: Recon
---
`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.instructions).toBe("");
	});

	test("trims instructions body of leading and trailing whitespace", () => {
		const content = `---
name: blitz
role: scout
task: Recon
---


   Body with leading and trailing whitespace.


`;

		const result = parseMarkdownAgent(content, FILE);
		expect("error" in result).toBe(false);
		if ("error" in result) return;
		expect(result.instructions).toBe("Body with leading and trailing whitespace.");
	});
});

describe("loadMarkdownAgents", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp("nano-team-md-loader-");
	});

	afterEach(async () => {
		await rm(tmpDir);
	});

	test("returns one entry per *.md file; non-md files are ignored", async () => {
		await writeFile(path.join(tmpDir, "blitz.md"), `---
name: blitz
role: scout
task: A
---
A1`);
		await writeFile(path.join(tmpDir, "grind.md"), `---
name: grind
role: implementer
task: B
---
B1`);
		await writeFile(path.join(tmpDir, "README.txt"), "ignore me");
		await writeFile(path.join(tmpDir, "notes.md.bak"), "also ignore");

		const entries = await loadMarkdownAgents(tmpDir, tmpDir);
		expect(entries.length).toBe(2);

		const files = entries.map((e) => e.file).sort();
		expect(files).toEqual(["blitz.md", "grind.md"]);

		for (const entry of entries) {
			expect("error" in entry).toBe(false);
		}
	});

	test("returns an error entry for a parse-failing file", async () => {
		await writeFile(path.join(tmpDir, "good.md"), `---
name: a
role: b
task: c
---
ok`);
		await writeFile(path.join(tmpDir, "bad.md"), `---
name: bad
role: two words
task: c
---
ok`);

		const entries = await loadMarkdownAgents(tmpDir, tmpDir);
		expect(entries.length).toBe(2);

		const bad = entries.find((e) => e.file === "bad.md");
		expect(bad).toBeDefined();
		if (!bad) return;
		expect("error" in bad).toBe(true);
		if (!("error" in bad)) return;
		expect(bad.error.toLowerCase()).toContain("role");
	});

	test("returns empty array when directory does not exist", async () => {
		const nonExistent = path.join(tmpDir, "does-not-exist");
		const entries = await loadMarkdownAgents(nonExistent, tmpDir);
		expect(entries).toEqual([]);
	});
});
