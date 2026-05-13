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

export async function loadModeFromMarkdown(filePath: string, mode: string): Promise<ModeDefinition> {
  const fs = (await import("fs")).promises;
  const yaml = (await import("js-yaml")).default;
  const raw = await fs.readFile(filePath, "utf-8");
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    throw new Error("No YAML frontmatter found");
  }
  const parsed = yaml.load(frontmatterMatch[1]);
  return validateModeDefinition(parsed, mode, filePath);
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

async function applyUserOverrides(
  definitions: Map<string, ModeDefinition>,
  userConfigPath: string,
  diagnostics: ModeCatalogDiagnostic[],
): Promise<void> {
  const fs = (await import("fs")).promises;
  const yaml = (await import("js-yaml")).default;

  let raw: string;
  try {
    raw = await fs.readFile(userConfigPath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return;
    diagnostics.push(diagnostic("warning", `User override read error: ${err.message}`, { file: userConfigPath }));
    return;
  }

  try {
    const parsed: any = yaml.load(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [mode, overrides] of Object.entries(parsed)) {
      if (!definitions.has(mode)) {
        diagnostics.push(diagnostic("warning", `Unknown user override ignored: ${mode}`, { mode, file: userConfigPath }));
        continue;
      }
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        diagnostics.push(diagnostic("warning", `User override for '${mode}' must be an object`, { mode, file: userConfigPath }));
        continue;
      }
      definitions.set(mode, { ...definitions.get(mode)!, ...(overrides as object), mode });
    }
  } catch (err: any) {
    diagnostics.push(diagnostic("warning", `User override parse error: ${err.message}`, { file: userConfigPath }));
  }
}

export async function loadAllModes(options: LoadModeCatalogOptions = {}): Promise<ModeCatalogResult> {
  const path = await import("path");
  const os = await import("os");
  const baseDir = path.dirname(new URL(import.meta.url).pathname);
  const modesDir = options.modesDir ?? path.join(baseDir, "..", "modes");
  const userConfigPath = options.userConfigPath ?? path.join(os.homedir(), ".pi", "modes", "config.yaml");
  const diagnostics: ModeCatalogDiagnostic[] = [];
  const definitions = new Map<string, ModeDefinition>();

  const modesToLoad = await listMarkdownModes(modesDir, diagnostics);
  for (const mode of modesToLoad) {
    const filePath = path.join(modesDir, `${mode}.md`);
    try {
      definitions.set(mode, await loadModeFromMarkdown(filePath, mode));
    } catch (err: any) {
      const required = (REQUIRED_BUILT_IN_MODES as readonly string[]).includes(mode);
      diagnostics.push(diagnostic(required ? "error" : "warning", `Mode '${mode}' load error: ${err.message}`, { mode, file: filePath }));
    }
  }

  for (const mode of REQUIRED_BUILT_IN_MODES) {
    if (!definitions.has(mode)) {
      diagnostics.push(diagnostic("error", `Required built-in mode missing: ${mode}`, { mode, file: path.join(modesDir, `${mode}.md`) }));
    }
  }

  if (diagnostics.some(d => d.level === "error")) {
    return { ok: false, diagnostics };
  }

  await applyUserOverrides(definitions, userConfigPath, diagnostics);

  return {
    ok: true,
    catalog: { definitions, loadedAt: options.now?.() ?? Date.now() },
    diagnostics,
  };
}

export function notifyModeCatalogDiagnostics(ctx: ExtensionContext, diagnostics: ModeCatalogDiagnostic[]): void {
  for (const item of diagnostics) {
    ctx.ui.notify(item.message, item.level === "error" ? "error" : "warning");
  }
}
