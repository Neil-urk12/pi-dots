export type BashPolicy = "strict_readonly" | "non_destructive" | "off";

/** Permission action for tool access control */
export type PermissionAction = "allow" | "ask" | "deny";

/** Overrides for bash command patterns */
export interface BashPatternOverrides {
  add?: string[];     // regex patterns to add
  remove?: string[];  // regex patterns to remove (matched by string equality against built-in source)
}

/** Configuration for bash command patterns */
export interface BashPatternConfig {
  safe?: BashPatternOverrides;
  destructive?: BashPatternOverrides;
}

/** Resolved bash patterns ready for evaluation */
export interface ResolvedBashPatterns {
  safe: RegExp[];
  destructive: RegExp[];
}

export interface ModeDefinition {
  mode: string;
  enabled_tools?: string[];     // tool names to enable; undefined or empty = all tools
  bash_policy?: BashPolicy;     // bash command policy for this mode
  prompt_suffix?: string;       // text injected into system prompt
  description?: string;         // human-readable description for UI
  border_label?: string;        // label displayed on editor border (e.g. " YOLO ")
  border_style?: 'accent' | 'warning' | 'success' | 'muted'; // future theming
  allowed_agents?: string[];    // subagent names allowed for delegation; undefined or empty = any agent
  permissions?: Record<string, PermissionAction>; // per-tool permission actions
  bash_patterns?: BashPatternConfig; // custom bash command patterns
  auto_mode_switch?: boolean;       // if true, skip confirmation for request_mode_switch tool
}

/** Canonical mode name type */
export type Mode = string;

/** Extract a human-readable error message from unknown throw value */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract error code from unknown throw value (for Node.js fs errors etc.) */
export function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/** Default mode when none specified */
export const DEFAULT_MODE = "orchestrator" as const;

/** Modes to try when current mode is unavailable */
export const SAFE_FALLBACK_MODES = ["plan", "ask", "yolo"] as const;

/** Fallback mode for interactive picker failures */
export const PICKER_FALLBACK_MODE = "yolo" as const;

/** Max allowed mode name length */
export const MAX_MODE_NAME_LENGTH = 50 as const;

/** Max chars shown in prompt suffix preview */
export const SUFFIX_PREVIEW_LENGTH = 120 as const;

/** Default user config path components */
export const USER_CONFIG_DIR = ".pi" as const;
export const USER_CONFIG_FILE = "modes/config.yaml" as const;
