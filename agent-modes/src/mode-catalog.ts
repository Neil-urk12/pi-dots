import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDefinition } from "./types.js";

export const REQUIRED_BUILT_IN_MODES = ["yolo", "plan", "code", "ask", "orchestrator"] as const;

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

function validateModeDefinition(parsed: any, expectedMode: string, file: string): ModeDefinition {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("YAML frontmatter must be an object");
  }
  if (parsed.mode !== expectedMode) {
    throw new Error(`Mode field '${parsed.mode}' does not match filename '${expectedMode}'`);
  }
  if (parsed.enabled_tools !== undefined) {
    if (!Array.isArray(parsed.enabled_tools)) {
      throw new Error("enabled_tools must be an array when present");
    }
    if (!parsed.enabled_tools.every((tool: unknown) => typeof tool === "string")) {
      throw new Error("enabled_tools must contain only strings");
    }
  }
  if (parsed.bash_policy !== undefined && !["strict_readonly", "non_destructive", "off"].includes(parsed.bash_policy)) {
    throw new Error("bash_policy must be one of strict_readonly, non_destructive, off");
  }
  if (parsed.border_style !== undefined && !["accent", "warning", "success", "muted"].includes(parsed.border_style)) {
    throw new Error("border_style must be one of accent, warning, success, muted");
  }
  return {
    mode: parsed.mode,
    enabled_tools: parsed.enabled_tools,
    bash_policy: parsed.bash_policy,
    prompt_suffix: parsed.prompt_suffix,
    description: parsed.description,
    border_label: parsed.border_label,
    border_style: parsed.border_style,
  };
}

async function parseModeDocumentFromMarkdown(filePath: string, mode: string): Promise<ParsedModeDocument> {
  const fs = (await import("fs")).promises;
  const yaml = (await import("js-yaml")).default;

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      throw new Error("No YAML frontmatter found");
    }
    return { mode, file: filePath, parsed: yaml.load(frontmatterMatch[1]) };
  } catch (err: any) {
    return { mode, file: filePath, error: err.message };
  }
}

export async function loadModeFromMarkdown(filePath: string, mode: string): Promise<ModeDefinition> {
  const document = await parseModeDocumentFromMarkdown(filePath, mode);
  if (document.error) throw new Error(document.error);
  return validateModeDefinition(document.parsed, mode, filePath);
}

async function listMarkdownModes(modesDir: string, diagnostics: ModeCatalogDiagnostic[]): Promise<Set<string>> {
  const fs = (await import("fs")).promises;
  const modes = new Set<string>(REQUIRED_BUILT_IN_MODES);
  try {
    const files = await fs.readdir(modesDir);
    for (const file of files) {
      if (file.endsWith(".md")) modes.add(file.replace(/\.md$/, ""));
    }
  } catch (err: any) {
    diagnostics.push(diagnostic("error", `Modes directory read error: ${err.message}`, { file: modesDir }));
  }
  return modes;
}

async function parseUserOverrides(userConfigPath: string): Promise<ParsedUserOverrides | undefined> {
  const fs = (await import("fs")).promises;
  const yaml = (await import("js-yaml")).default;

  try {
    const raw = await fs.readFile(userConfigPath, "utf-8");
    try {
      return { file: userConfigPath, parsed: yaml.load(raw) };
    } catch (err: any) {
      return { file: userConfigPath, parseError: err.message };
    }
  } catch (err: any) {
    if (err.code === "ENOENT") return undefined;
    return { file: userConfigPath, readError: err.message };
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
    definitions.set(mode, { ...definitions.get(mode)!, ...(overrides as object), mode });
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
    } catch (err: any) {
      const required = (REQUIRED_BUILT_IN_MODES as readonly string[]).includes(document.mode);
      diagnostics.push(diagnostic(required ? "error" : "warning", `Mode '${document.mode}' load error: ${err.message}`, { mode: document.mode, file: document.file }));
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
  const baseDir = path.dirname(new URL(import.meta.url).pathname);
  const modesDir = options.modesDir ?? path.join(baseDir, "..", "modes");
  const userConfigPath = options.userConfigPath ?? path.join(os.homedir(), ".pi", "modes", "config.yaml");
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
