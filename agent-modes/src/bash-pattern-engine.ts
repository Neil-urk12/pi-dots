/**
 * Bash pattern engine — owns pattern definitions, resolution, matching, and validation.
 *
 * This module has no dependency on mode catalogs, tool policy, or delegation logic.
 * It is the single source of truth for what constitutes a safe, destructive, or
 * severity-overridden bash command.
 */
import type { BashPolicy, BashPatternConfig, ResolvedBashPatterns, BashPatternSeverity } from "./types.js";

// ── Pattern definitions ──

/** Match a command at start of line or after shell operators (&&, ||, ;, |). */
const SHELL_CMD_PREFIX = "(?:^|[;&|]{1,2})\\s*";

/** Build a regex source string with the shell-command prefix. */
const cmd = (suffix: string) => SHELL_CMD_PREFIX + suffix;

/** Detect nested quantifiers (e.g. `(a+)+`) that risk ReDoS catastrophic backtracking. */
const REDOS_PATTERN = /(?<![\\])\((?:[^)\\]|\\.)*[+*](?:[^)\\]|\\.)*\)[+*?]/;

const MAX_BASH_PATTERN_LENGTH = 200;

export const DESTRUCTIVE_PATTERNS_SOURCE: readonly string[] = [
  cmd("rm\\b"),
  cmd("rmdir\\b"),
  cmd("mv\\b"),
  cmd("cp\\b"),
  cmd("mkdir\\b"),
  cmd("touch\\b"),
  cmd("chmod\\b"),
  cmd("chown\\b"),
  cmd("chgrp\\b"),
  cmd("ln\\b"),
  cmd("tee\\b"),
  cmd("truncate\\b"),
  cmd("dd\\b"),
  cmd("shred\\b"),
  "(^|[^<])>(?!>)",
  cmd(">>"),
  cmd("npm\\s+(install|uninstall|update|ci|link|publish)"),
  cmd("yarn\\s+(add|remove|install|publish)"),
  cmd("pnpm\\s+(add|remove|install|publish)"),
  cmd("pip\\s+(install|uninstall)"),
  cmd("apt(-get)?\\s+(install|remove|purge|update|upgrade)"),
  cmd("brew\\s+(install|uninstall|upgrade)"),
  cmd("git\\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)"),
  cmd("sudo\\b"),
  cmd("su\\b"),
  cmd("kill\\b"),
  cmd("pkill\\b"),
  cmd("killall\\b"),
  cmd("reboot\\b"),
  cmd("shutdown\\b"),
  cmd("systemctl\\s+(start|stop|restart|enable|disable)"),
  cmd("service\\s+\\S+\\s+(start|stop|restart)"),
  cmd("(vim?|nano|emacs|code|subl)\\b"),
  cmd("curl\\b.*\\s-(?:[a-zA-Z]*[oO])(?!\\s*-)"),
  cmd("curl\\b.*--output\\b"),
  cmd("curl\\b.*--remote-name\\b"),
  cmd("curl\\b.*--remote-header-name\\b"),
  cmd("curl\\b.*--create-dirs\\b"),
];

export const SAFE_PATTERNS_SOURCE: readonly string[] = [
  cmd("cat\\b"),
  cmd("head\\b"),
  cmd("tail\\b"),
  cmd("less\\b"),
  cmd("more\\b"),
  cmd("grep\\b"),
  cmd("find\\b"),
  cmd("ls\\b"),
  cmd("pwd\\b"),
  cmd("echo\\b"),
  cmd("printf\\b"),
  cmd("wc\\b"),
  cmd("sort\\b"),
  cmd("uniq\\b"),
  cmd("diff\\b"),
  cmd("file\\b"),
  cmd("stat\\b"),
  cmd("du\\b"),
  cmd("df\\b"),
  cmd("tree\\b"),
  cmd("which\\b"),
  cmd("whereis\\b"),
  cmd("type\\b"),
  cmd("env\\b"),
  cmd("printenv\\b"),
  cmd("uname\\b"),
  cmd("whoami\\b"),
  cmd("id\\b"),
  cmd("date\\b"),
  cmd("cal\\b"),
  cmd("uptime\\b"),
  cmd("ps\\b"),
  cmd("top\\b"),
  cmd("htop\\b"),
  cmd("free\\b"),
  cmd("git\\s+(status|log|diff|show|branch|remote|config\\s+--get)"),
  cmd("git\\s+ls-"),
  cmd("npm\\s+(list|ls|view|info|search|outdated|audit)"),
  cmd("yarn\\s+(list|info|why|audit)"),
  cmd("node\\s+--version"),
  cmd("python\\s+--version"),
  cmd("wget\\s+-O\\s*-"),
  cmd("jq\\b"),
  cmd("sed\\s+-n"),
  cmd("awk\\b"),
  cmd("rg\\b"),
  cmd("fd\\b"),
  cmd("bat\\b"),
  cmd("eza\\b"),
];

// ── Cached builtins ──

const BUILTIN_PATTERNS: ResolvedBashPatterns = {
  safe: [...SAFE_PATTERNS_SOURCE].map(p => new RegExp(p)),
  destructive: [...DESTRUCTIVE_PATTERNS_SOURCE].map(p => new RegExp(p, "i")),
  safeSource: [...SAFE_PATTERNS_SOURCE],
  destructiveSource: [...DESTRUCTIVE_PATTERNS_SOURCE],
};

function getBuiltinPatterns(): ResolvedBashPatterns {
  return BUILTIN_PATTERNS;
}

// ── Resolution ──

/** Resolve bash patterns from config and overrides */
export function resolveBashPatterns(
  globalOverrides?: BashPatternConfig,
  modeOverrides?: BashPatternConfig,
): ResolvedBashPatterns {
  const builtin = getBuiltinPatterns();
  const safe: RegExp[] = [...builtin.safe];
  const destructive: RegExp[] = [...builtin.destructive];
  const safeSource: string[] = [...SAFE_PATTERNS_SOURCE];
  const destructiveSource: string[] = [...DESTRUCTIVE_PATTERNS_SOURCE];

  // Apply global overrides
  if (globalOverrides) {
    applyPatternOverrides(safe, safeSource, globalOverrides.safe);
    applyPatternOverrides(destructive, destructiveSource, globalOverrides.destructive);
  }

  // Apply mode-specific overrides
  if (modeOverrides) {
    applyPatternOverrides(safe, safeSource, modeOverrides.safe);
    applyPatternOverrides(destructive, destructiveSource, modeOverrides.destructive);
  }

  // Build severity map from overrides
  const severity: Map<string, BashPatternSeverity> = new Map();

  function applySeverityOverrides(overrides?: BashPatternConfig) {
    if (!overrides) return;
    const sev = overrides.destructive?.severity;
    if (!sev) return;
    for (const [pattern, s] of Object.entries(sev)) {
      severity.set(pattern, s as BashPatternSeverity);
    }
  }

  applySeverityOverrides(globalOverrides);
  applySeverityOverrides(modeOverrides);

  return {
    safe,
    destructive,
    safeSource,
    destructiveSource,
    severity: severity.size > 0 ? severity : undefined,
  };
}

function applyPatternOverrides(
  target: RegExp[],
  source: string[],
  overrides?: { add?: string[]; remove?: string[] },
): void {
  if (!overrides) return;

  // Remove patterns by matching source strings
  if (overrides.remove) {
    const removeSet = new Set(overrides.remove);
    const keepIndices: number[] = [];
    for (let i = 0; i < source.length; i++) {
      if (!removeSet.has(source[i])) {
        keepIndices.push(i);
      }
    }
    // Rebuild both arrays with only kept items
    const keptTarget = keepIndices.map(i => target[i]);
    const keptSource = keepIndices.map(i => source[i]);
    target.length = 0;
    source.length = 0;
    target.push(...keptTarget);
    source.push(...keptSource);
  }

  // Add patterns
  if (overrides.add) {
    for (const patternToAdd of overrides.add) {
      if (patternToAdd.length > MAX_BASH_PATTERN_LENGTH) {
        console.warn(`[pi-agent-modes] Skipping bash pattern exceeding ${MAX_BASH_PATTERN_LENGTH} chars`);
        continue;
      }

      if (REDOS_PATTERN.test(patternToAdd)) {
        console.warn(`[pi-agent-modes] Skipping bash pattern with nested quantifiers (ReDoS risk): ${patternToAdd}`);
        continue;
      }
      try {
        target.push(new RegExp(patternToAdd));
        source.push(patternToAdd);
      } catch (e) {
        console.warn(`[pi-agent-modes] Skipping invalid bash pattern: ${patternToAdd} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

// ── Validation ──

/** Validate a regex pattern string */
export function validateBashPattern(pattern: string): { valid: boolean; error?: string } {
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (e: unknown) {
    return { valid: false, error: `Invalid regex: ${pattern} — ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── Matching ──

export function isDestructiveCommand(command: string, patterns: ResolvedBashPatterns): boolean {
  return patterns.destructive.some((pattern) => pattern.test(command));
}

export function isSafeCommand(command: string, patterns: ResolvedBashPatterns): boolean {
  return !isDestructiveCommand(command, patterns) && patterns.safe.some((pattern) => pattern.test(command));
}

/**
 * Check if a bash command matches any pattern with a severity override.
 * Returns ask/block result if matched, null if no override applies.
 */
export function checkBashSeverity(
  command: string,
  patterns: ResolvedBashPatterns,
): { severity: "allow" } | { severity: "ask"; matchedPattern: string } | { severity: "block"; matchedPattern: string } | null {
  const severityMap = patterns.severity;
  if (!severityMap || severityMap.size === 0) return null;

  for (const patternSource of patterns.destructiveSource ?? []) {
    const sev = severityMap.get(patternSource);
    if (!sev) continue;
    if (sev === "allow") {
      // Explicitly allowed — check if matches
      try {
        const regex = new RegExp(patternSource, "i");
        if (regex.test(command)) {
          return { severity: "allow" };
        }
      } catch { /* skip */ }
      continue;
    }
    try {
      const regex = new RegExp(patternSource, "i");
      if (regex.test(command)) {
        return { severity: sev as "ask" | "block", matchedPattern: patternSource };
      }
    } catch {
      // skip invalid patterns (shouldn't happen since we validated on load)
    }
  }

  return null;
}

/** Resolve the effective bash policy for a mode, falling back to defaults. */
export function resolveBashPolicy(mode: string, definition?: { bash_policy?: BashPolicy }): BashPolicy {
  if (definition?.bash_policy) return definition.bash_policy;
  const normalized = mode.trim().toLowerCase();
  if (normalized === "plan" || normalized === "ask") return "strict_readonly";
  if (normalized === "code") return "non_destructive";
  return "strict_readonly";
}

/** Check whether a bash command passes a mode's bash policy. Returns true if allowed. */
export function isBashCommandAllowed(
  command: string,
  bashPolicy: BashPolicy,
  patterns: ResolvedBashPatterns,
): boolean {
  // Severity overrides take precedence
  const severityCheck = checkBashSeverity(command, patterns);
  if (severityCheck) {
    return severityCheck.severity !== "block";
  }

  if (bashPolicy === "strict_readonly") return isSafeCommand(command, patterns);
  if (bashPolicy === "non_destructive") return !isDestructiveCommand(command, patterns);
  // bash_policy === "off" — everything allowed
  return true;
}
