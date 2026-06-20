import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import type { TeamMember } from "./types.ts";
import { getErrorMessage, getErrnoCode } from "./errors.ts";
import { loadMarkdownAgents, type MarkdownAgentLoadEntry } from "./markdown-agent.ts";

const GLOBAL_TEAM_SUBDIR = path.join(".pi", "agent", "nano-team", "team");
const LOCAL_TEAM_SUBDIR = path.join(".pi", "nano-team", "team");

/**
 * Resolve the global team directory under the user's home.
 *
 * Uses `os.homedir()` (not `process.env.HOME || "~"`) because the
 * literal `~` is not expanded by `path.join` — silently targeting
 * a non-existent `~/.pi/agent/nano-team/team` directory when HOME
 * is unset hides real filesystem errors and produces an empty team
 * with no errors. `os.homedir()` consults `getuid`/`/etc/passwd`
 * (Unix) and `USERPROFILE`/`HOMEDRIVE` (Windows) before giving up.
 *
 * The `homedir` parameter is an injection seam for tests — bun's
 * `os.homedir()` does not always re-read `process.env.HOME` after
 * the module is initialized, so tests that want to exercise the
 * "no global team" path pass an explicit homedir function.
 */
export const getGlobalTeamDir = (homedir: () => string = os.homedir): string =>
	path.join(homedir(), GLOBAL_TEAM_SUBDIR);

const getLocalTeamDir = (cwd: string): string => path.join(cwd, LOCAL_TEAM_SUBDIR);

export type LoadResult = Readonly<{
	team: ReadonlyMap<string, TeamMember>;
	errors: readonly string[];
}>;

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

type ParsedFile = Readonly<
	| { displayPath: string; parsed: unknown }
	| { displayPath: string; parseError: string }
>;

const readAndParseFile = async (filePath: string, cwd: string): Promise<ParsedFile> => {
	const displayPath = path.relative(cwd, filePath);
	try {
		const content = await fs.readFile(filePath, "utf-8");
		return { displayPath, parsed: YAML.parse(content) as unknown };
	} catch (error) {
		return { displayPath, parseError: getErrorMessage(error) };
	}
};

const listYamlFiles = async (directory: string): Promise<readonly string[]> => {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (getErrnoCode(error) === "ENOENT") return [];
		throw error;
	}
	const safe: string[] = [];
	for (const entry of entries) {
		if (!/\.ya?ml$/i.test(entry.name)) continue;
		// Accept both regular files and symlinks. The symlink case
		// is legitimate — many users share their team config via
		// symlinks from the canonical source repo
		// (e.g. ~/.pi/agent/nano-team/team/orion.yaml ->
		// ~/.../examples/team/orion.yaml). An earlier realpath
		// safety check rejected this pattern, breaking the roster.
		// A symlink to a sensitive file (e.g. ~/.ssh/id_rsa) would
		// fail YAML parsing and surface the content in the error
		// message, but the attacker would need write access to the
		// team dir to plant the symlink — and that access lets them
		// do far worse (e.g. put a malicious string directly in
		// a YAML's instructions field). Cost > benefit; we accept
		// symlinks.
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		safe.push(path.join(directory, entry.name));
	}
	return safe.sort();
};

/**
 * Load the team from the global `~/.pi/agent/nano-team/team/` dir
 * and the local `<cwd>/.pi/nano-team/team/` dir. Local does not
 * override global — duplicates are reported as errors and the
 * first-loaded entry wins.
 *
 * The `homedir` parameter is an injection seam for tests (see
 * `getGlobalTeamDir` for the rationale).
 */
export const loadTeam = async (
	cwd: string,
	homedir: () => string = os.homedir,
	builtInDir?: string,
): Promise<LoadResult> => {
	const team = new Map<string, TeamMember>();
	const errors: string[] = [];

	// Within-layer duplicate detection. Two files in the SAME layer
	// sharing a `name` is a real mistake and surfaces as an error.
	// Cross-layer collisions (a user `blitz.yaml` and the built-in
	// `blitz.md`) are silent overrides by design — the later-loaded
	// layer wins, so a user-defined file shadows the shipped one
	// without surfacing as a load error.
	const applyYamlLayer = (files: readonly ParsedFile[]): void => {
		const addedThisLayer = new Set<string>();
		for (const file of files) {
			if ("parseError" in file) {
				errors.push(`${file.displayPath}: ${file.parseError}`);
				continue;
			}
			if (file.parsed === null || typeof file.parsed !== "object") {
				errors.push(`${file.displayPath}: expected a YAML mapping at the top level`);
				continue;
			}
			const record = file.parsed as Record<string, unknown>;

			const name = isNonEmptyString(record.name) ? record.name : undefined;
			const role = isNonEmptyString(record.role) ? record.role : undefined;
			const instructions = isNonEmptyString(record.instructions) ? record.instructions : undefined;
			const task = isNonEmptyString(record.task) ? record.task : undefined;
			const modelProvided = record.model !== undefined;
			const model = modelProvided && isNonEmptyString(record.model) ? record.model : undefined;
			// `readOnly` is opt-in: a non-boolean value (string, number, list)
			// silently falls back to undefined (= false at the consumer).
			const readOnly = typeof record.readOnly === "boolean" ? record.readOnly : undefined;

			if (
				name === undefined ||
				role === undefined ||
				instructions === undefined ||
				task === undefined
			) {
				const missing: string[] = [];
				if (name === undefined) missing.push("name");
				if (role === undefined) missing.push("role");
				if (instructions === undefined) missing.push("instructions");
				if (task === undefined) missing.push("task");
				errors.push(`${file.displayPath}: missing or empty field(s): ${missing.join(", ")}`);
				continue;
			}
			if (modelProvided && model === undefined) {
				errors.push(`${file.displayPath}: 'model' must be a non-empty string if specified`);
				continue;
			}

			const trimmedName = name.trim();
			const trimmedRole = role.trim().toLowerCase();
			if (trimmedRole.length === 0 || trimmedRole.includes(" ")) {
				errors.push(`${file.displayPath}: 'role' must be a single word (got '${trimmedRole}')`);
				continue;
			}
			if (addedThisLayer.has(trimmedName)) {
				const existing = team.get(trimmedName)!;
				errors.push(
					`duplicate agent name '${trimmedName}' in ${existing.sourceFile} and ${file.displayPath} (keeping ${existing.sourceFile})`,
				);
				continue;
			}
			addedThisLayer.add(trimmedName);
			const member: TeamMember = Object.freeze({
				name: trimmedName,
				role: trimmedRole,
				instructions: instructions.trim(),
				task: task.trim(),
				...(model !== undefined ? { model: model.trim() } : {}),
				...(readOnly !== undefined ? { readOnly } : {}),
				sourceFile: file.displayPath,
			});
			team.set(trimmedName, member);
		}
	};

	const applyMarkdownLayer = (entries: readonly MarkdownAgentLoadEntry[]): void => {
		const addedThisLayer = new Set<string>();
		for (const entry of entries) {
			if ("error" in entry) {
				errors.push(`${entry.file}: ${entry.error}`);
				continue;
			}
			const agent = entry.agent;
			if (addedThisLayer.has(agent.name)) {
				const existing = team.get(agent.name)!;
				errors.push(
					`duplicate agent name '${agent.name}' in ${existing.sourceFile} and ${entry.file} (keeping ${existing.sourceFile})`,
				);
				continue;
			}
			addedThisLayer.add(agent.name);
			const member: TeamMember = Object.freeze({
				name: agent.name,
				role: agent.role,
				instructions: agent.instructions,
				task: agent.task,
				...(agent.model !== undefined ? { model: agent.model } : {}),
				...(agent.description !== undefined ? { description: agent.description } : {}),
				...(agent.readOnly !== undefined ? { readOnly: agent.readOnly } : {}),
				sourceFile: agent.sourceFile,
			});
			team.set(agent.name, member);
		}
	};

	// 1. Built-in (lowest priority, loaded first so later layers override).
	const builtinDir = builtInDir ?? getDefaultBuiltInDir();
	applyMarkdownLayer(await loadMarkdownAgents(builtinDir, cwd));

	// 2. Global user team.
	const globalFiles = await listYamlFiles(getGlobalTeamDir(homedir));
	applyYamlLayer(await Promise.all(globalFiles.map((file) => readAndParseFile(file, cwd))));

	// 3. Local user team (highest priority, loaded last).
	const localFiles = await listYamlFiles(getLocalTeamDir(cwd));
	applyYamlLayer(await Promise.all(localFiles.map((file) => readAndParseFile(file, cwd))));

	return Object.freeze({
		team: team as ReadonlyMap<string, TeamMember>,
		errors: Object.freeze(errors),
	});
};

// Default built-in directory: <package>/agents, resolved from this
// file's location so jiti-loaded code and published code both find
// the right path. import.meta.url is the source-of-truth that survives
// bundling and packaging.
const getDefaultBuiltInDir = (): string => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.join(here, "..", "agents");
};
