import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Providers that ship with pi itself — no extension needed. */
const BUILTIN_PROVIDERS = new Set([
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"opencode",
]);

/** Session-level cache: provider name → absolute extension path. */
const providerCache = new Map<string, string>();

/** Whether we've already scanned extensions this session. */
let scanned = false;

/**
 * Parse the provider slug from a model string.
 * Format: `provider/model-name` — returns everything before the first `/`.
 */
function parseProvider(model: string): string {
	const slash = model.indexOf("/");
	if (slash <= 0) return model;
	return model.slice(0, slash);
}

/**
 * Get the list of installed extension paths by running `pi list`.
 * Returns an array of absolute paths to extension directories/files.
 */
function getExtensionPaths(piBinCommand: string, piBinBaseArgs: string[] = []): string[] {
	try {
		const cmd = [piBinCommand, ...piBinBaseArgs, "list"].join(" ");
		const output = execSync(cmd, {
			encoding: "utf-8",
			timeout: 5000,
		});

		const paths: string[] = [];
		for (const line of output.split("\n")) {
			// Lines starting with whitespace are indented paths
			if (line.startsWith(" ") || line.startsWith("\t")) {
				const trimmed = line.trim();
				if (trimmed) paths.push(trimmed);
			}
		}
		return paths;
	} catch {
		return [];
	}
}

/**
 * Collect all .ts files in an extension directory (recursive).
 */
function collectSourceFiles(extPath: string): string[] {
	const files: string[] = [];
	function walk(dir: string) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === "dist") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
				files.push(full);
			}
		}
	}
	walk(extPath);
	return files;
}

/**
 * Read source and extract provider names from `registerProvider("name", ...)` calls.
 * Handles both literal string args and constant references.
 */
function extractRegisteredProviders(
	source: string,
): string[] {
	const providers: string[] = [];

	// Match literal string: registerProvider("name", ...) or registerProvider('name', ...)
	const literalRe = /registerProvider\s*\(\s*["']([A-Za-z]\w*)["']/g;
	let match: RegExpExecArray | null;
	while ((match = literalRe.exec(source)) !== null) {
		providers.push(match[1]);
	}

	return providers;
}

/**
 * Check if source contains any `registerProvider` call at all.
 */
function hasRegisterProvider(source: string): boolean {
	return /registerProvider\s*\(/.test(source);
}

/**
 * Extract constant→value mappings for provider name constants.
 * Matches patterns like: export const PROVIDER_KILO = "kilo"
 */
function extractProviderConstants(source: string): Map<string, string> {
	const constants = new Map<string, string>();
	const constRe = /(?:export\s+)?const\s+(PROVIDER_\w+)\s*=\s*["']([A-Za-z]\w*)["']/g;
	let match: RegExpExecArray | null;
	while ((match = constRe.exec(source)) !== null) {
		constants.set(match[1], match[2]);
	}
	return constants;
}

/**
 * Scan all installed extensions and build the provider→extension cache.
 * Scans all .ts files in each extension (not just entry point) to find
 * registerProvider calls, including those in submodules.
 */
function scanExtensions(piBinCommand: string, piBinBaseArgs: string[]): void {
	if (scanned) return;
	scanned = true;

	const extPaths = getExtensionPaths(piBinCommand, piBinBaseArgs);

	for (const extPath of extPaths) {
		const sourceFiles = collectSourceFiles(extPath);
		if (sourceFiles.length === 0) continue;

		// First pass: collect all PROVIDER_* constants across the extension
		const allConstants = new Map<string, string>();
		let hasAnyRegisterProvider = false;
		const fileSources = new Map<string, string>();

		for (const filePath of sourceFiles) {
			let source: string;
			try {
				source = fs.readFileSync(filePath, "utf-8");
			} catch {
				continue;
			}
			fileSources.set(filePath, source);

			if (hasRegisterProvider(source)) {
				hasAnyRegisterProvider = true;
			}

			for (const [constName, value] of extractProviderConstants(source)) {
				allConstants.set(constName, value);
			}
		}

		// Second pass: extract literal provider names from registerProvider calls
		const providers = new Set<string>();
		for (const [, source] of fileSources) {
			for (const name of extractRegisteredProviders(source)) {
				providers.add(name);
			}
			// Also match registerProvider(CONSTANT, ...) and resolve via constants
			const constRefRe = /registerProvider\s*\(\s*([A-Z_]+)\s*,/g;
			let match: RegExpExecArray | null;
			while ((match = constRefRe.exec(source)) !== null) {
				const resolved = allConstants.get(match[1]);
				if (resolved) providers.add(resolved);
			}
		}

		if (providers.size > 0) {
			for (const name of providers) {
				if (!providerCache.has(name)) {
					providerCache.set(name, extPath);
				}
			}
		} else if (hasAnyRegisterProvider) {
			// Fallback: derive provider name from extension directory name
			const dirName = path.basename(extPath);
			const candidates = [dirName, dirName.replace(/^pi-/, "")];
			for (const candidate of candidates) {
				if (candidate && !providerCache.has(candidate)) {
					providerCache.set(candidate, extPath);
				}
			}
		}
	}
}

/**
 * Resolve which extension provides the provider for a given model string.
 *
 * @param model - Model string in `provider/model-name` format
 * @param piBinCommand - The pi CLI command (e.g., "pi" or "/path/to/pi")
 * @returns Absolute path to the extension that registers the provider, or `undefined` if
 *          the provider is builtin or no extension was found.
 */
export async function resolveProviderExtension(
	model: string,
	piBinCommand: string,
	piBinBaseArgs: string[] = [],
): Promise<string | undefined> {
	const provider = parseProvider(model);

	// Builtin providers don't need an extension
	if (BUILTIN_PROVIDERS.has(provider)) {
		return undefined;
	}

	// Check cache first
	if (providerCache.has(provider)) {
		return providerCache.get(provider);
	}

	// Scan extensions (idempotent — only runs once per session)
	scanExtensions(piBinCommand, piBinBaseArgs);

	return providerCache.get(provider);
}

/**
 * Reset internal state — useful for testing.
 */
export function _resetCache(): void {
	providerCache.clear();
	scanned = false;
}
