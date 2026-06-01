import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDefinition } from "./types.js";
import { USER_CONFIG_DIR, USER_CONFIG_FILE, errorMessage, errorCode } from "./types.js";

export const REQUIRED_BUILT_IN_MODES = ["yolo", "plan", "code", "ask", "orchestrator"] as const;

let _fs: typeof import("node:fs").promises | undefined;
async function getFs() { return (_fs ??= (await import("node:fs")).promises); }

let _yaml: typeof import("js-yaml").default | undefined;
async function getYaml() { return (_yaml ??= (await import("js-yaml")).default); }

export type DiagnosticLevel = "warning" | "error";

export interface ModeCatalogDiagnostic {
  level: DiagnosticLevel;
  message: string;
  mode?: string;
  file?: string;
}

export interface ModeCatalog {
  definitions: Map<string, ModeDefinition>;
  loadedAt: number;
}

export type ModeCatalogResult =
  | { ok: true; catalog: ModeCatalog; diagnostics: ModeCatalogDiagnostic[] }
  | { ok: false; diagnostics: ModeCatalogDiagnostic[] };

export interface LoadModeCatalogOptions {
  modesDir?: string;
  userConfigPath?: string;
  now?: () => number;
}

export interface ParsedModeDocument {
  mode: string;
  file: string;
  parsed?: unknown;
  error?: string;
}

export interface ParsedUserOverrides {
  file: string;
  parsed?: unknown;
  readError?: string;
  parseError?: string;
}

export interface BuildModeCatalogInput {
  modeDocuments: readonly ParsedModeDocument[];
  userOverrides?: ParsedUserOverrides;
  diagnostics?: readonly ModeCatalogDiagnostic[];
  fileForMode?: (mode: string) => string;
  now?: () => number;
}

function diagnostic(level: DiagnosticLevel, message: string, extras: Partial<ModeCatalogDiagnostic> = {}): ModeCatalogDiagnostic {
  return { level, message, ...extras };
}

const VALID_MODE_NAME = /^[a-z0-9_-]+$/;

function validateModeDefinition(parsed: unknown, expectedMode: string, file: string): ModeDefinition {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("YAML frontmatter must be an object");
  }
  const input = parsed as Record<string, unknown>;
  if (input.mode !== expectedMode) {
    throw new Error(`Mode field '${input.mode}' does not match filename '${expectedMode}'`);
  }
  if (!VALID_MODE_NAME.test(String(input.mode))) {
    throw new Error(`Invalid mode name '${input.mode}' — must be lowercase alphanumeric with hyphens/underscores`);
  }
  if (input.enabled_tools !== undefined) {
    if (!Array.isArray(input.enabled_tools)) {
      throw new Error("enabled_tools must be an array when present");
    }
    if (!input.enabled_tools.every((tool: unknown) => typeof tool === "string")) {
      throw new Error("enabled_tools must contain only strings");
    }
  }
  if (input.bash_policy !== undefined && !["strict_readonly", "non_destructive", "off"].includes(String(input.bash_policy))) {
    throw new Error("bash_policy must be one of strict_readonly, non_destructive, off");
  }
  if (input.border_style !== undefined && !["accent", "warning", "success", "muted"].includes(String(input.border_style))) {
    throw new Error("border_style must be one of accent, warning, success, muted");
  }
  if (input.allowed_agents !== undefined) {
    if (!Array.isArray(input.allowed_agents)) {
      throw new Error("allowed_agents must be an array when present");
    }
    if (!input.allowed_agents.every((agent: unknown) => typeof agent === "string")) {
      throw new Error("allowed_agents must contain only strings");
    }
  }
  return {
    mode: String(input.mode),
    enabled_tools: input.enabled_tools as string[] | undefined,
    bash_policy: input.bash_policy as ModeDefinition["bash_policy"],
    prompt_suffix: typeof input.prompt_suffix === "string" ? input.prompt_suffix : undefined,
    description: typeof input.description === "string" ? input.description : undefined,
    border_label: typeof input.border_label === "string" ? input.border_label : undefined,
    border_style: input.border_style as ModeDefinition["border_style"],
    allowed_agents: input.allowed_agents as string[] | undefined,
  };
}

async function parseModeDocumentFromMarkdown(filePath: string, mode: string): Promise<ParsedModeDocument> {
  const fs = await getFs();
  const yaml = await getYaml();

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      throw new Error("No YAML frontmatter found");
    }
    return { mode, file: filePath, parsed: yaml.load(frontmatterMatch[1], { json: true }) };
  } catch (err: unknown) {
    return { mode, file: filePath, error: errorMessage(err) };
  }
}

export async function loadModeFromMarkdown(filePath: string, mode: string): Promise<ModeDefinition> {
  const document = await parseModeDocumentFromMarkdown(filePath, mode);
  if (document.error) throw new Error(document.error);
  return validateModeDefinition(document.parsed, mode, filePath);
}

async function listMarkdownModes(modesDir: string, diagnostics: ModeCatalogDiagnostic[]): Promise<Set<string>> {
  const fs = await getFs();
  const modes = new Set<string>(REQUIRED_BUILT_IN_MODES);
  try {
    const files = await fs.readdir(modesDir);
    for (const file of files) {
      if (file.endsWith(".md")) modes.add(file.replace(/\.md$/, ""));
    }
  } catch (err: unknown) {
    diagnostics.push(diagnostic("error", `Modes directory read error: ${errorMessage(err)}`, { file: modesDir }));
  }
  return modes;
}

async function parseUserOverrides(userConfigPath: string): Promise<ParsedUserOverrides | undefined> {
  const fs = await getFs();
  const yaml = await getYaml();

  try {
    const raw = await fs.readFile(userConfigPath, "utf-8");
    try {
      return { file: userConfigPath, parsed: yaml.load(raw, { json: true }) };
    } catch (err: unknown) {
      return { file: userConfigPath, parseError: errorMessage(err) };
    }
  } catch (err: unknown) {
    if (errorCode(err) === "ENOENT") return undefined;
    return { file: userConfigPath, readError: errorMessage(err) };
  }
}

function applyUserOverrides(
  definitions: Map<string, ModeDefinition>,
  userOverrides: ParsedUserOverrides | undefined,
  diagnostics: ModeCatalogDiagnostic[],
): void {
  if (!userOverrides) return;

  if (userOverrides.readError) {
    diagnostics.push(diagnostic("warning", `User override read error: ${userOverrides.readError}`, { file: userOverrides.file }));
    return;
  }

  if (userOverrides.parseError) {
    diagnostics.push(diagnostic("warning", `User override parse error: ${userOverrides.parseError}`, { file: userOverrides.file }));
    return;
  }

  const parsed: any = userOverrides.parsed;
  if (!parsed || typeof parsed !== "object") return;
  for (const [mode, overrides] of Object.entries(parsed)) {
    if (!definitions.has(mode)) {
      diagnostics.push(diagnostic("warning", `Unknown user override ignored: ${mode}`, { mode, file: userOverrides.file }));
      continue;
    }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      diagnostics.push(diagnostic("warning", `User override for '${mode}' must be an object`, { mode, file: userOverrides.file }));
      continue;
    }
    const allowedKeys: (keyof ModeDefinition)[] = ["enabled_tools", "bash_policy", "prompt_suffix", "description", "border_label", "border_style", "allowed_agents"];  
    const filtered: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (key in overrides) filtered[key] = (overrides as Record<string, unknown>)[key];
    }
    definitions.set(mode, { ...definitions.get(mode)!, ...filtered, mode });
  }
}

export function buildModeCatalog(input: BuildModeCatalogInput): ModeCatalogResult {
  const diagnostics: ModeCatalogDiagnostic[] = [...(input.diagnostics ?? [])];
  const definitions = new Map<string, ModeDefinition>();
  const fileForMode = input.fileForMode ?? ((mode: string) => mode);

  for (const document of input.modeDocuments) {
    if (document.error) {
      const required = (REQUIRED_BUILT_IN_MODES as readonly string[]).includes(document.mode);
      diagnostics.push(diagnostic(required ? "error" : "warning", `Mode '${document.mode}' load error: ${document.error}`, { mode: document.mode, file: document.file }));
      continue;
    }

    try {
      definitions.set(document.mode, validateModeDefinition(document.parsed, document.mode, document.file));
    } catch (err: unknown) {
      const required = (REQUIRED_BUILT_IN_MODES as readonly string[]).includes(document.mode);
      diagnostics.push(diagnostic(required ? "error" : "warning", `Mode '${document.mode}' load error: ${errorMessage(err)}`, { mode: document.mode, file: document.file }));
    }
  }

  for (const mode of REQUIRED_BUILT_IN_MODES) {
    if (!definitions.has(mode)) {
      diagnostics.push(diagnostic("error", `Required built-in mode missing: ${mode}`, { mode, file: fileForMode(mode) }));
    }
  }

  if (diagnostics.some(d => d.level === "error")) {
    return { ok: false, diagnostics };
  }

  applyUserOverrides(definitions, input.userOverrides, diagnostics);

  return {
    ok: true,
    catalog: { definitions, loadedAt: input.now?.() ?? Date.now() },
    diagnostics,
  };
}

export async function loadAllModes(options: LoadModeCatalogOptions = {}): Promise<ModeCatalogResult> {
  const path = await import("path");
  const os = await import("os");
  const { fileURLToPath } = await import("url");
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const modesDir = options.modesDir ?? path.join(baseDir, "..", "modes");
  const userConfigPath = options.userConfigPath ?? path.join(os.homedir(), USER_CONFIG_DIR, USER_CONFIG_FILE);
  const diagnostics: ModeCatalogDiagnostic[] = [];

  const modesToLoad = await listMarkdownModes(modesDir, diagnostics);
  const modeDocuments: ParsedModeDocument[] = [];
  for (const mode of modesToLoad) {
    const filePath = path.join(modesDir, `${mode}.md`);
    modeDocuments.push(await parseModeDocumentFromMarkdown(filePath, mode));
  }

  return buildModeCatalog({
    modeDocuments,
    userOverrides: await parseUserOverrides(userConfigPath),
    diagnostics,
    fileForMode: (mode) => path.join(modesDir, `${mode}.md`),
    now: options.now,
  });
}

export function notifyModeCatalogDiagnostics(ctx: ExtensionContext, diagnostics: ModeCatalogDiagnostic[]): void {
  for (const item of diagnostics) {
    ctx.ui.notify(item.message, item.level === "error" ? "error" : "warning");
  }
}
