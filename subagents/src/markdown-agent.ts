import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as YAML from "yaml";
import { getErrnoCode } from "./errors.ts";

export type ParsedMarkdownAgent = Readonly<{
	name: string;
	role: string;
	description?: string;
	model?: string;
	task: string;
	instructions: string;
	sourceFile: string;
	/**
	 * When true, multiple live instances of this agent may run concurrently.
	 * Defaults to undefined (= false at the consumer).
	 */
	readOnly?: boolean;
}>;

export type MarkdownAgentLoadEntry = Readonly<
	| { file: string; agent: ParsedMarkdownAgent }
	| { file: string; error: string }
>;

// Captures frontmatter between the two `---` markers. `\r?\n` keeps
// CRLF files parseable; `[\s\S]*?` is the non-greedy "anything" that
// stops at the first closing `---`.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

const isString = (value: unknown): value is string => typeof value === "string";

export const parseMarkdownAgent = (
	content: string,
	file: string,
): ParsedMarkdownAgent | { error: string } => {
	const match = FRONTMATTER_RE.exec(content);
	if (!match) {
		return { error: "missing frontmatter (expected `---` ... `---` delimiters)" };
	}

	const [, frontmatterText, body] = match;
	// The regex has exactly two capture groups and `match` was non-null,
	// so these are always defined. Under `noUncheckedIndexedAccess` TS
	// widens them to `string | undefined`, so we narrow explicitly.
	if (frontmatterText === undefined || body === undefined) {
		return { error: "frontmatter delimiters found but body capture missing" };
	}
	let parsed: unknown;
	try {
		parsed = YAML.parse(frontmatterText);
	} catch (yamlError) {
		const message = yamlError instanceof Error ? yamlError.message : String(yamlError);
		return { error: `invalid YAML in frontmatter: ${message}` };
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: "frontmatter must be a YAML mapping" };
	}

	const record = parsed as Record<string, unknown>;

	const name = isNonEmptyString(record.name) ? record.name : undefined;
	const role = isNonEmptyString(record.role) ? record.role : undefined;
	const task = isNonEmptyString(record.task) ? record.task : undefined;
	const description =
		record.description !== undefined && isString(record.description)
			? record.description
			: undefined;
	const model = record.model !== undefined && isString(record.model) ? record.model : undefined;
	const readOnly = typeof record.readOnly === "boolean" ? record.readOnly : undefined;

	if (name === undefined) return { error: "missing or empty field: name" };
	if (role === undefined) return { error: "missing or empty field: role" };
	if (task === undefined) return { error: "missing or empty field: task" };

	const trimmedRole = role.trim().toLowerCase();
	if (trimmedRole.length === 0 || /\s/.test(trimmedRole)) {
		return { error: `'role' must be a single lowercased word (got '${role}')` };
	}

	const agent: {
		name: string;
		role: string;
		description?: string;
		model?: string;
		task: string;
		instructions: string;
		sourceFile: string;
		readOnly?: boolean;
	} = {
		name: name.trim(),
		role: trimmedRole,
		task: task.trim(),
		instructions: body.trim(),
		sourceFile: file,
	};
	if (description !== undefined) agent.description = description.trim();
	if (model !== undefined) agent.model = model.trim();
	if (readOnly !== undefined) agent.readOnly = readOnly;

	return Object.freeze(agent);
};

export const loadMarkdownAgents = async (
	dir: string,
	cwd: string,
): Promise<readonly MarkdownAgentLoadEntry[]> => {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (getErrnoCode(error) === "ENOENT") return [];
		throw error;
	}

	const mdFiles = entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
		.map((entry) => entry.name)
		.sort();
	const results: MarkdownAgentLoadEntry[] = [];
	for (const name of mdFiles) {
		const fullPath = path.join(dir, name);
		const displayPath = path.relative(cwd, fullPath);
		let content: string;
		try {
			content = await fs.readFile(fullPath, "utf-8");
		} catch (readError) {
			const message = readError instanceof Error ? readError.message : String(readError);
			results.push({ file: displayPath, error: `read failed: ${message}` });
			continue;
		}

		const parsed = parseMarkdownAgent(content, displayPath);
		if ("error" in parsed) {
			results.push({ file: displayPath, error: parsed.error });
		} else {
			results.push({ file: displayPath, agent: parsed });
		}
	}

	return results;
};
