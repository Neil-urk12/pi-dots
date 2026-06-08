import type { BashPolicy, ModeDefinition, PermissionAction, BashPatternConfig, ResolvedBashPatterns } from "./types.js";
import { DELEGATION_TOOLS } from "./types.js";

export type ModeCatalogMap = Map<string, { 
  enabled_tools?: string[]; 
  bash_policy?: BashPolicy; 
  allowed_agents?: string[];
  permissions?: Record<string, PermissionAction>;
  bash_patterns?: BashPatternConfig;
}>;

/** Case-insensitive check: does list contain item? */
function includesCI(list: string[], item: string): boolean {
  const lower = item.toLowerCase();
  return list.some(a => a.toLowerCase() === lower);
}

export interface ModeToolPolicyInput {
  mode: string;
  definition?: ModeDefinition;
  toolName: string;
  input?: unknown;
  /** Full mode catalog. Undefined entries or empty enabled_tools = unrestricted (all tools allowed). */
  catalog?: ModeCatalogMap;
  /** Known available agent names from the subagent system. Used to validate allowed_agents. */
  availableAgents?: string[];
  /** Resolved bash patterns for this mode. */
  bashPatterns?: ResolvedBashPatterns;
}

export interface ModeToolPolicyDecision {
  block: boolean;
  reason?: string;
  suggestedModes?: string[];  // modes that would allow this tool call
  warning?: string;  // non-blocking config issue (e.g. allowed_agents entry not found in availableAgents)
  ask?: boolean;      // true when user should be prompted
  askMessage?: string; // message to show in confirmation dialog
}

/**
 * Given a tool name (and optional bash command), return which modes from the catalog
 * would allow that tool call.
 */
export function findModesForTool(
  toolName: string,
  definitions: ModeCatalogMap,
  input?: unknown,
  bashPatterns?: ResolvedBashPatterns,
): string[] {
  const result: string[] = [];

  for (const [mode, def] of definitions) {
    // Check permissions first
    if (def.permissions && toolName in def.permissions) {
      const action = def.permissions[toolName];
      if (action === "deny") continue; // explicitly denied
      if (action === "allow" || action === "ask") {
        result.push(mode);
        continue;
      }
    }

    // Check tool allowlist
    const allowed = def.enabled_tools;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(toolName)) {
      continue; // tool not in this mode's allowlist
    }

    // For delegation tools, also check allowed_agents
    if (DELEGATION_TOOLS.includes(toolName as typeof DELEGATION_TOOLS[number])) {
      const allowedAgents = def.allowed_agents;
      if (Array.isArray(allowedAgents) && allowedAgents.length > 0) {
        const requestedAgents = agentNamesFromInput(toolName, input);
        if (requestedAgents.some(a => !includesCI(allowedAgents, a))) {
          continue; // agent not allowed in this mode
        }
      }
    }

    // For bash, also check bash_policy
    if (toolName === "bash") {
      const command = commandFromInput(input);
      const policy = def.bash_policy;
      const resolvedPolicy = policy ?? resolveDefaultBashPolicy(mode);

      if (resolvedPolicy === "strict_readonly" && !isSafeCommand(command, bashPatterns ?? getBuiltinPatterns())) {
        continue; // bash command not allowed in strict_readonly
      }
      if (resolvedPolicy === "non_destructive" && isDestructiveCommand(command, bashPatterns ?? getBuiltinPatterns())) {
        continue; // destructive bash not allowed in non_destructive
      }
    }

    result.push(mode);
  }

  return result;
}

function resolveDefaultBashPolicy(mode: string): BashPolicy {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "plan" || normalized === "ask") return "strict_readonly";
  if (normalized === "code") return "non_destructive";
  return "strict_readonly";
}

const FAIL_CLOSED_READ_ONLY_TOOLS = new Set([
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "questionnaire",
  "ask_user_question",
]);

const MAX_BASH_PATTERN_LENGTH = 200;

/** Detect nested quantifiers (e.g. `(a+)+`) that risk ReDoS catastrophic backtracking. */
const REDOS_PATTERN = /(?<![\\])\((?:[^)\\]|\\.)*[+*](?:[^)\\]|\\.)*\)[+*?]/;

const DESTRUCTIVE_PATTERNS_SOURCE = [
  "\\brm\\b",
  "\\brmdir\\b",
  "\\bmv\\b",
  "\\bcp\\b",
  "\\bmkdir\\b",
  "\\btouch\\b",
  "\\bchmod\\b",
  "\\bchown\\b",
  "\\bchgrp\\b",
  "\\bln\\b",
  "\\btee\\b",
  "\\btruncate\\b",
  "\\bdd\\b",
  "\\bshred\\b",
  "(^|[^<])>(?!>)",
  ">>",
  "\\bnpm\\s+(install|uninstall|update|ci|link|publish)",
  "\\byarn\\s+(add|remove|install|publish)",
  "\\bpnpm\\s+(add|remove|install|publish)",
  "\\bpip\\s+(install|uninstall)",
  "\\bapt(-get)?\\s+(install|remove|purge|update|upgrade)",
  "\\bbrew\\s+(install|uninstall|upgrade)",
  "\\bgit\\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)",
  "\\bsudo\\b",
  "\\bsu\\b",
  "\\bkill\\b",
  "\\bpkill\\b",
  "\\bkillall\\b",
  "\\breboot\\b",
  "\\bshutdown\\b",
  "\\bsystemctl\\s+(start|stop|restart|enable|disable)",
  "\\bservice\\s+\\S+\\s+(start|stop|restart)",
  "\\b(vim?|nano|emacs|code|subl)\\b",
  "\\bcurl\\b.*\\s-(?:[a-zA-Z]*[oO])(?!\\s*-)",
  "\\bcurl\\b.*--output\\b",
  "\\bcurl\\b.*--remote-name\\b",
  "\\bcurl\\b.*--remote-header-name\\b",
  "\\bcurl\\b.*--create-dirs\\b",
];

const SAFE_PATTERNS_SOURCE = [
  "^\\s*cat\\b",
  "^\\s*head\\b",
  "^\\s*tail\\b",
  "^\\s*less\\b",
  "^\\s*more\\b",
  "^\\s*grep\\b",
  "^\\s*find\\b",
  "^\\s*ls\\b",
  "^\\s*pwd\\b",
  "^\\s*echo\\b",
  "^\\s*printf\\b",
  "^\\s*wc\\b",
  "^\\s*sort\\b",
  "^\\s*uniq\\b",
  "^\\s*diff\\b",
  "^\\s*file\\b",
  "^\\s*stat\\b",
  "^\\s*du\\b",
  "^\\s*df\\b",
  "^\\s*tree\\b",
  "^\\s*which\\b",
  "^\\s*whereis\\b",
  "^\\s*type\\b",
  "^\\s*env\\b",
  "^\\s*printenv\\b",
  "^\\s*uname\\b",
  "^\\s*whoami\\b",
  "^\\s*id\\b",
  "^\\s*date\\b",
  "^\\s*cal\\b",
  "^\\s*uptime\\b",
  "^\\s*ps\\b",
  "^\\s*top\\b",
  "^\\s*htop\\b",
  "^\\s*free\\b",
  "^\\s*git\\s+(status|log|diff|show|branch|remote|config\\s+--get)",
  "^\\s*git\\s+ls-",
  "^\\s*npm\\s+(list|ls|view|info|search|outdated|audit)",
  "^\\s*yarn\\s+(list|info|why|audit)",
  "^\\s*node\\s+--version",
  "^\\s*python\\s+--version",
  "^\\s*wget\\s+-O\\s*-",
  "^\\s*jq\\b",
  "^\\s*sed\\s+-n",
  "^\\s*awk\\b",
  "^\\s*rg\\b",
  "^\\s*fd\\b",
  "^\\s*bat\\b",
  "^\\s*eza\\b",
];

/** Get built-in patterns as RegExp arrays (cached at module level) */
const BUILTIN_PATTERNS: ResolvedBashPatterns = {
  safe: SAFE_PATTERNS_SOURCE.map(p => new RegExp(p)),
  destructive: DESTRUCTIVE_PATTERNS_SOURCE.map(p => new RegExp(p, "i")),
};

function getBuiltinPatterns(): ResolvedBashPatterns {
  return BUILTIN_PATTERNS;
}

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

  return { safe, destructive };
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

/** Validate a regex pattern string */
export function validateBashPattern(pattern: string): { valid: boolean; error?: string } {
  try {
    new RegExp(pattern);
    return { valid: true };
  } catch (e: unknown) {
    return { valid: false, error: `Invalid regex: ${pattern} — ${e instanceof Error ? e.message : String(e)}` };
  }
}


export function evaluateToolCall({ 
  mode, 
  definition, 
  toolName, 
  input, 
  catalog, 
  availableAgents,
  bashPatterns 
}: ModeToolPolicyInput): ModeToolPolicyDecision {
  const suggestedModes = catalog ? findModesForTool(toolName, catalog, input, bashPatterns) : undefined;
  
  // Check explicit permissions first
  const action = definition?.permissions?.[toolName];
  if (action) {
    if (action === "deny") {
      return {
        block: true,
        reason: `${mode.toUpperCase()} mode explicitly denies tool: ${toolName}`,
        suggestedModes,
      };
    }
    if (action === "allow") {
      const warning = definition?.bash_policy
        ? `permissions.allow for "${toolName}" overrides bash_policy "${definition.bash_policy}"`
        : undefined;
      return { block: false, suggestedModes, warning };
    
    }
    if (action === "ask") {
      const warning = definition?.bash_policy
        ? `permissions.ask for "${toolName}" alongside bash_policy "${definition.bash_policy}"`
        : undefined;
      return {
        block: false,
        ask: true,
        askMessage: `Allow tool "${toolName}" in ${mode.toUpperCase()} mode?`,
        suggestedModes,
        warning,
      };
    }
  }

  if (!definition) {
    if (!FAIL_CLOSED_READ_ONLY_TOOLS.has(toolName)) {
      return {
        block: true,
        reason: `Mode '${mode}' not initialized — fail-closed blocks tool: ${toolName}`,
        suggestedModes,
      };
    }

    if (toolName === "bash") {
      const command = commandFromInput(input);
      const patterns = bashPatterns ?? getBuiltinPatterns();
      if (!isSafeCommand(command, patterns)) {
        return {
          block: true,
          reason: `Mode '${mode}' not initialized — fail-closed blocked unsafe command: ${command}`,
          suggestedModes,
        };
      }
    }

    return { block: false, suggestedModes };
  }

  const allowed = definition.enabled_tools;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(toolName)) {
    return {
      block: true,
      reason: `${mode.toUpperCase()} mode blocks tool: ${toolName}. Allowed tools: ${allowed.join(", ")}`,
      suggestedModes,
    };
  }

  // Agent name validation for delegation tools
  if (DELEGATION_TOOLS.includes(toolName as typeof DELEGATION_TOOLS[number])) {
    const allowedAgents = definition.allowed_agents;
    if (Array.isArray(allowedAgents) && allowedAgents.length > 0) {
      const requestedAgents = agentNamesFromInput(toolName, input);
      const blocked = requestedAgents.filter(a => !includesCI(allowedAgents, a));
      if (blocked.length > 0) {
        return {
          block: true,
          reason: `${mode.toUpperCase()} mode does not allow agent(s): ${blocked.join(", ")}. Allowed agents: ${allowedAgents.join(", ")}`,
          suggestedModes,
        };
      }
    }

    // Warn if allowed_agents lists agents not found in availableAgents
    if (Array.isArray(definition.allowed_agents) && definition.allowed_agents.length > 0 && Array.isArray(availableAgents) && availableAgents.length > 0) {
      const missing = definition.allowed_agents.filter(a => !includesCI(availableAgents, a));
      if (missing.length > 0) {
        return {
          block: false,
          suggestedModes,
          warning: `allowed_agents references unknown agent(s): ${missing.join(", ")}. Available agents: ${availableAgents.join(", ")}`,
        };
      }
    }
  }

  if (toolName === "bash") {
    const command = commandFromInput(input);
    const bashPolicy = resolveBashPolicy(mode, definition);
    const patterns = bashPatterns ?? getBuiltinPatterns();

    if (bashPolicy === "strict_readonly" && !isSafeCommand(command, patterns)) {
      return {
        block: true,
        reason: `${mode.toUpperCase()} mode blocked unsafe command: ${command}\nAllowed read-only commands only.`,
        suggestedModes,
      };
    }

    if (bashPolicy === "non_destructive" && isDestructiveCommand(command, patterns)) {
      return {
        block: true,
        reason: `${mode.toUpperCase()} mode blocked destructive command: ${command}\nAllowed development commands only.`,
        suggestedModes,
      };
    }
  }

  return { block: false, suggestedModes };
}

function commandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as { command?: unknown }).command;
  return typeof value === "string" ? value : "";
}

/** Extract agent name(s) from subagent/Agent tool input. */
function agentNamesFromInput(toolName: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;

  if (toolName === "subagent") {
    const names: string[] = [];
    if (typeof obj.agent === "string") names.push(obj.agent);
    if (Array.isArray(obj.tasks)) {
      for (const t of obj.tasks) {
        if (t && typeof t === "object" && typeof (t as Record<string, unknown>).agent === "string") {
          names.push((t as Record<string, unknown>).agent as string);
        }
      }
    }
    if (Array.isArray(obj.chain)) {
      for (const t of obj.chain) {
        if (t && typeof t === "object" && typeof (t as Record<string, unknown>).agent === "string") {
          names.push((t as Record<string, unknown>).agent as string);
        }
      }
    }
    return names;
  }

  if (toolName === "Agent") {
    if (typeof obj.subagent_type === "string") return [obj.subagent_type];
  }

  return [];
}

function resolveBashPolicy(mode: string, definition: ModeDefinition): BashPolicy {
  if (definition.bash_policy) return definition.bash_policy;
  return resolveDefaultBashPolicy(mode);
}

function isDestructiveCommand(command: string, patterns: ResolvedBashPatterns): boolean {
  return patterns.destructive.some((pattern) => pattern.test(command));
}

function isSafeCommand(command: string, patterns: ResolvedBashPatterns): boolean {
  return !isDestructiveCommand(command, patterns) && patterns.safe.some((pattern) => pattern.test(command));
}
