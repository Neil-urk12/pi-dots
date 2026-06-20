import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getGlobalTeamDir,
	loadTeam,
	type LoadResult,
} from "../team.ts";
import { getErrnoCode } from "../errors.ts";
import { loadMarkdownAgents } from "../markdown-agent.ts";
import { makeMember } from "./helpers.ts";

const mkdtemp = (prefix: string): Promise<string> =>
	fs.mkdtemp(path.join(os.tmpdir(), prefix));

const writeFile = (filePath: string, content: string): Promise<void> =>
	fs.writeFile(filePath, content, "utf-8");

const rm = (dir: string): Promise<void> => fs.rm(dir, { recursive: true, force: true });

describe("getErrnoCode (regression: no `as NodeJS.ErrnoException` cast)", () => {
	test("returns .code for Error instances", () => {
		const err = Object.assign(new Error("enoent"), { code: "ENOENT" });
		expect(getErrnoCode(err)).toBe("ENOENT");
	});

	test("returns undefined for plain objects (not silently treated as ENOENT)", () => {
		// Regression: the previous (error as NodeJS.ErrnoException).code
		// cast was unsound — a plain object { code: "ENOENT" } (not an
		// Error) would be silently treated as an ENOENT filesystem
		// error and the real cause would be masked. The fix requires
		// instanceof Error.
		expect(getErrnoCode({ code: "ENOENT" })).toBeUndefined();
		expect(getErrnoCode({ code: "EACCES", message: "denied" })).toBeUndefined();
	});

	test("returns undefined for non-Error throws (strings, null, numbers)", () => {
		// Same bug class as the (error as Error).message cast in
		// subagent.ts that we just fixed. A string throw would have
		// silently looked like an ENOENT error in the old code.
		expect(getErrnoCode("ENOENT")).toBeUndefined();
		expect(getErrnoCode(null)).toBeUndefined();
		expect(getErrnoCode(undefined)).toBeUndefined();
		expect(getErrnoCode(42)).toBeUndefined();
	});

	test("returns undefined for an Error instance without a .code field", () => {
		expect(getErrnoCode(new Error("oops"))).toBeUndefined();
	});

	test("returns undefined when .code is not a string (e.g., a number)", () => {
		// Defensive: a non-string .code should not be passed through
		// as if it were a Node.js errno string.
		const err = Object.assign(new Error("weird"), { code: 42 });
		expect(getErrnoCode(err)).toBeUndefined();
	});
});

describe("getGlobalTeamDir (regression: no `process.env.HOME || '~'` fallback)", () => {
	test("returns an absolute path that never starts with the literal '~'", () => {
		// Regression: process.env.HOME || '~' silently produced a
		// literal '~/.pi/agent/nano-team/team' path when HOME was
		// unset. path.join does not expand '~', so the path was
		// relative to a non-existent location and loadTeam returned
		// an empty team with no errors — masking real filesystem
		// issues. The fix uses os.homedir(), which is always absolute.
		const dir = getGlobalTeamDir(() => "/explicit/mock/home");
		expect(path.isAbsolute(dir)).toBe(true);
		expect(dir.startsWith("~")).toBe(false);
	});

	test("default homedir (os.homedir) never returns the literal '~'", () => {
		// The structural property: with the old (HOME || '~') fallback,
		// an unset HOME produced a path starting with '~' (not absolute).
		// With os.homedir(), the path is always absolute or the function
		// throws — both are correct; silently returning a broken
		// '~/.pi/...' path is the bug.
		const saved = process.env.HOME;
		delete process.env.HOME;
		try {
			const dir = getGlobalTeamDir();
			expect(dir.startsWith("~")).toBe(false);
		} catch {
			// os.homedir() can throw on some platforms when HOME is unset.
			// Throwing is correct — silently returning '~/...' is the bug.
		} finally {
			if (saved !== undefined) process.env.HOME = saved;
		}
	});
});

describe("loadTeam (regression: typed extraction, ReadonlyMap)", () => {
	let tempDir: string;
	let emptyHome: string;

	beforeEach(async () => {
		tempDir = await mkdtemp("nano-team-test-");
		emptyHome = await mkdtemp("nano-team-empty-home-");
	});

	afterEach(async () => {
		await rm(tempDir);
		await rm(emptyHome);
	});

	test("loads a regular YAML file from the local team directory", async () => {
		const teamDir = path.join(tempDir, ".pi", "nano-team", "team");
		await fs.mkdir(teamDir, { recursive: true });
		await writeFile(
			path.join(teamDir, "blitz.yaml"),
			"name: blitz\nrole: explorer\ninstructions: 'explore stuff'\ntask: 'find things'\n",
		);

		const result = await loadTeam(tempDir, () => emptyHome);
		expect(result.team.has("blitz")).toBe(true);
		const blitz = result.team.get("blitz");
		expect(blitz?.role).toBe("explorer");
		expect(blitz?.instructions).toBe("explore stuff");
		expect(result.errors).toEqual([]);
	});

	test("returns a ReadonlyMap (caller mutations blocked at the type level)", async () => {
		// Regression: the previous Object.freeze(team) cast was a
		// runtime lie — Object.freeze does not prevent
		// Map.prototype.set/delete/clear (those are on the prototype,
		// not the object). The fix relies on the ReadonlyMap type
		// contract. The @ts-expect-error below would fail (Unused
		// ts-expect-error) if a future refactor reverts to a mutable
		// Map return type.
		const result: LoadResult = await loadTeam(tempDir, () => emptyHome);
		// @ts-expect-error — ReadonlyMap has no .set method
		result.team.set("foo", makeMember("foo"));
		expect(result.team).toBeDefined();
	});

	test("returns empty team when no layers have any files", async () => {
		// Regression: built-in layer is now an explicit third input.
		// Passing a non-existent builtInDir isolates this test from the
		// real package's agents/ directory (which ships four built-ins).
		const noBuiltin = path.join(tempDir, "no-builtin-here");
		const result = await loadTeam(tempDir, () => emptyHome, noBuiltin);
		expect(result.team.size).toBe(0);
		expect(result.errors).toEqual([]);
	});

	test("rejects a file with missing required fields (typed extraction rejects gracefully)", async () => {
		// Sanity check: the refactor that replaced
		// (record.X as string) casts with type guards should still
		// reject malformed records. This guards against the refactor
		// accidentally weakening the validation.
		const teamDir = path.join(tempDir, ".pi", "nano-team", "team");
		await fs.mkdir(teamDir, { recursive: true });
		await writeFile(
			path.join(teamDir, "broken.yaml"),
			"name: broken\nrole: explorer\n",
		);

		const result = await loadTeam(tempDir, () => emptyHome);
		expect(result.team.has("broken")).toBe(false);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain("missing or empty field(s)");
		expect(result.errors[0]).toContain("instructions");
		expect(result.errors[0]).toContain("task");
	});

	test("rejects a non-string model field (typed extraction rejects gracefully)", async () => {
		// Sanity check: the refactor that collapsed the duplicate
		// isNonEmptyString(record.model) check should still reject
		// non-string model values.
		const teamDir = path.join(tempDir, ".pi", "nano-team", "team");
		await fs.mkdir(teamDir, { recursive: true });
		await writeFile(
			path.join(teamDir, "badmini.yaml"),
			"name: badmini\nrole: tester\ninstructions: 'inst'\ntask: 'tsk'\nmodel: 42\n",
		);

		const result = await loadTeam(tempDir, () => emptyHome);
		expect(result.team.has("badmini")).toBe(false);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain("'model' must be a non-empty string");
	});

describe("loadTeam (built-in overlay)", () => {
	let tempDir: string;
	let emptyHome: string;
	let tempBuiltIn: string;

	beforeEach(async () => {
		tempDir = await mkdtemp("nano-team-test-");
		emptyHome = await mkdtemp("nano-team-empty-home-");
		tempBuiltIn = await mkdtemp("nano-team-builtin-");
	});

	afterEach(async () => {
		await rm(tempDir);
		await rm(emptyHome);
		await rm(tempBuiltIn);
	});

	test("loads all four built-ins when no user teams exist", async () => {
		for (const [name, role] of [
			["blitz", "scout"],
			["grind", "worker"],
			["yen", "reviewer"],
			["seeker", "researcher"],
		] as const) {
			await writeFile(
				path.join(tempBuiltIn, `${name}.md`),
				`---\nname: ${name}\nrole: ${role}\ntask: t\n---\nbody\n`,
			);
		}

		const result = await loadTeam(tempDir, () => emptyHome, tempBuiltIn);
		expect(result.team.size).toBe(4);
		expect(result.team.has("blitz")).toBe(true);
		expect(result.team.has("grind")).toBe(true);
		expect(result.team.has("yen")).toBe(true);
		expect(result.team.has("seeker")).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("global user file shadows built-in (same name)", async () => {
		await writeFile(
			path.join(tempBuiltIn, "yen.md"),
			"---\nname: yen\nrole: reviewer\ntask: built-in\n---\nbuilt-in instructions\n",
		);
		const globalTeam = path.join(emptyHome, ".pi", "agent", "nano-team", "team");
		await fs.mkdir(globalTeam, { recursive: true });
		await writeFile(
			path.join(globalTeam, "yen.yaml"),
			"name: yen\nrole: reviewer\ninstructions: 'user instructions'\ntask: 'user task'\n",
		);

		const result = await loadTeam(tempDir, () => emptyHome, tempBuiltIn);
		const yen = result.team.get("yen");
		expect(yen).toBeDefined();
		expect(yen?.task).toBe("user task");
		expect(yen?.instructions).toBe("user instructions");
		expect(yen?.sourceFile).toMatch(/\.pi[\\/]agent[\\/]nano-team[\\/]team[\\/]yen\.yaml$/);
		expect(result.errors).toEqual([]);
	});

	test("local user file shadows both global and built-in", async () => {
		await writeFile(
			path.join(tempBuiltIn, "yen.md"),
			"---\nname: yen\nrole: reviewer\ntask: built-in\n---\n",
		);
		const globalTeam = path.join(emptyHome, ".pi", "agent", "nano-team", "team");
		await fs.mkdir(globalTeam, { recursive: true });
		await writeFile(
			path.join(globalTeam, "yen.yaml"),
			"name: yen\nrole: reviewer\ninstructions: 'global inst'\ntask: 'global task'\n",
		);
		const localTeam = path.join(tempDir, ".pi", "nano-team", "team");
		await fs.mkdir(localTeam, { recursive: true });
		await writeFile(
			path.join(localTeam, "yen.yaml"),
			"name: yen\nrole: reviewer\ninstructions: 'local inst'\ntask: 'local task'\n",
		);

		const result = await loadTeam(tempDir, () => emptyHome, tempBuiltIn);
		const yen = result.team.get("yen");
		expect(yen?.task).toBe("local task");
		expect(yen?.instructions).toBe("local inst");
		expect(yen?.sourceFile).toMatch(/\.pi[\\/]nano-team[\\/]team[\\/]yen\.yaml$/);
		expect(result.errors).toEqual([]);
	});

	test("duplicate name within the built-in layer surfaces as an error", async () => {
		await writeFile(
			path.join(tempBuiltIn, "a.md"),
			"---\nname: clash\nrole: scout\ntask: t\n---\n",
		);
		await writeFile(
			path.join(tempBuiltIn, "b.md"),
			"---\nname: clash\nrole: worker\ntask: t\n---\n",
		);

		const result = await loadTeam(tempDir, () => emptyHome, tempBuiltIn);
		expect(result.team.has("clash")).toBe(true);
		expect(result.team.size).toBe(1);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain("clash");
		expect(result.errors[0]).toMatch(/duplicate/i);
	});

	test("built-in parse error surfaces as a load error, other built-ins still load", async () => {
		await writeFile(
			path.join(tempBuiltIn, "broken.md"),
			'---\nname: broken\nrole: [unclosed\ntask: t\n---\n',
		);
		await writeFile(
			path.join(tempBuiltIn, "good.md"),
			"---\nname: good\nrole: scout\ntask: t\n---\nbody\n",
		);

		const result = await loadTeam(tempDir, () => emptyHome, tempBuiltIn);
		expect(result.team.has("good")).toBe(true);
		expect(result.team.has("broken")).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toContain("broken");
	});

	test("missing built-in dir is silently treated as an empty layer", async () => {
		const nonexistent = path.join(tempDir, "no-builtin-" + Date.now());
		const result = await loadTeam(tempDir, () => emptyHome, nonexistent);
		expect(result.team.size).toBe(0);
		expect(result.errors).toEqual([]);
	});

	test("markdown agent description is surfaced on the TeamMember", async () => {
		await writeFile(
			path.join(tempBuiltIn, "with-desc.md"),
			`---\nname: with-desc\nrole: scout\ndescription: A short summary\ntask: t\n---\nbody\n`,
		);
		const result = await loadTeam(tempDir, () => emptyHome, tempBuiltIn);
		const m = result.team.get("with-desc");
		expect(m?.description).toBe("A short summary");
	});
});
});
