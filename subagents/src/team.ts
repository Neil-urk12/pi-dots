import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import type { TeamMember } from "./types.ts";
import { getErrorMessage } from "./errors.ts";

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

/**
 * Read the `code` field from a caught value if it's a real Error.
 *
 * The previous `(error as NodeJS.ErrnoException).code` cast was
 * unsound: a plain object `{ code: "ENOENT" }` (not an Error) would
 * be silently treated as an ENOENT filesystem error and the real
 * cause (e.g., a thrown config value) would be masked. This helper
 * requires `instanceof Error` so only genuine Node.js errors are
 * classified by their `code` field.
 */
export const getErrnoCode = (error: unknown): string | undefined => {
	if (error instanceof Error && "code" in error) {
		const code = (error as { code: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
};

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
	let entries: fs.Dirent[];
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
): Promise<LoadResult> => {
	const [globalFiles, localFiles] = await Promise.all([
		listYamlFiles(getGlobalTeamDir(homedir)),
		listYamlFiles(getLocalTeamDir(cwd)),
	]);
	const files = [...globalFiles, ...localFiles];
	const parsedFiles = await Promise.all(files.map((file) => readAndParseFile(file, cwd)));

	const team = new Map<string, TeamMember>();
	const errors: string[] = [];

	for (const file of parsedFiles) {
		if ("parseError" in file) {
			errors.push(`${file.displayPath}: ${file.parseError}`);
			continue;
		}
		if (file.parsed === null || typeof file.parsed !== "object") {
			errors.push(`${file.displayPath}: expected a YAML mapping at the top level`);
			continue;
		}
		const record = file.parsed as Record<string, unknown>;

		// Extract typed values via the isNonEmptyString type guard.
		// The narrowing is local to each call; we re-assign to a
		// `string | undefined` local and check the union explicitly
		// below so the rest of the loop operates on the narrowed
		// `string` type (no `as string` casts on the original
		// `unknown` field — those were unsound narrowing).
		const name = isNonEmptyString(record.name) ? record.name : undefined;
		const role = isNonEmptyString(record.role) ? record.role : undefined;
		const instructions = isNonEmptyString(record.instructions) ? record.instructions : undefined;
		const task = isNonEmptyString(record.task) ? record.task : undefined;
		const modelProvided = record.model !== undefined;
		const model = modelProvided && isNonEmptyString(record.model) ? record.model : undefined;

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
		if (trimmedRole.includes(" ")) {
			errors.push(`${file.displayPath}: 'role' must be a single word (got '${trimmedRole}')`);
			continue;
		}
		const existing = team.get(trimmedName);
		if (existing) {
			errors.push(
				`duplicate agent name '${trimmedName}' in ${existing.sourceFile} and ${file.displayPath} (keeping ${existing.sourceFile})`,
			);
			continue;
		}
		const member: TeamMember = Object.freeze({
			name: trimmedName,
			role: trimmedRole,
			instructions: instructions.trim(),
			task: task.trim(),
			...(model !== undefined ? { model: model.trim() } : {}),
			sourceFile: file.displayPath,
		});
		team.set(trimmedName, member);
	}

	// Note: `team` is returned as ReadonlyMap. Object.freeze on a
	// Map is a no-op (Map methods live on the prototype, not the
	// object), so the type contract is the only protection. The
	// implementation never mutates `team` after this return.
	return Object.freeze({
		team: team as ReadonlyMap<string, TeamMember>,
		errors: Object.freeze(errors),
	});
};
