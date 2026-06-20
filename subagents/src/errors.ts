/**
 * Extract a string message from an unknown thrown value. The
 * `catch (error)` clause in TypeScript gives us `unknown`, and the
 * old `(error as Error).message` pattern was unsound — for a string
 * or object throw, `(string as Error).message` is `undefined` and
 * the user sees `lastError: undefined` in the UI.
 *
 * Use this anywhere a thrown value is converted to a user-facing
 * message at a system boundary.
 */
export const getErrorMessage = (error: unknown): string => {
	if (error instanceof Error) return error.message;
	return String(error);
};

/**
 * Extract a Node.js errno `code` string (e.g. `"ENOENT"`) from an
 * unknown thrown value. Requires `instanceof Error` so only genuine
 * Node.js errors are classified — a plain object `{ code: "ENOENT" }`
 * is deliberately rejected to avoid masking real causes.
 */
export const getErrnoCode = (error: unknown): string | undefined => {
	if (error instanceof Error && "code" in error) {
		const code = (error as { code: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
};
