/**
 * Mode tool policy — evaluates whether a tool call should be allowed, blocked, or
 * prompted in the current mode. Delegates bash pattern matching to bash-pattern-engine.
 */
import type { BashPolicy, ModeDefinition, PermissionAction, BashPatternConfig, ResolvedBashPatterns } from "./types.js";
import { DELEGATION_TOOLS } from "./types.js";
import { commandFromInput } from "./mode-bypass.js";
import {
  resolveBashPatterns,
  resolveBashPolicy,
  isSafeCommand,
  isDestructiveCommand,
  checkBashSeverity,
  isBashCommandAllowed,
  validateBashPattern,
} from "./bash-pattern-engine.js";

// Re-export for backward compatibility (consumers import from mode-tool-policy)
export { resolveBashPatterns, validateBashPattern } from "./bash-pattern-engine.js";

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
  /** Pre-resolved bash patterns. If omitted, engine resolves from raw configs below. */
  bashPatterns?: ResolvedBashPatterns;
  /** Global bash pattern config (from user config). Used when bashPatterns is omitted. */
  globalBashPatterns?: BashPatternConfig;
  /** Mode-specific bash pattern config. Used when bashPatterns is omitted. */
  modeBashPatterns?: BashPatternConfig;
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
 * would allow that tool call. Uses bash-pattern-engine directly for bash policy checks
 * — no call cycle with evaluateToolCall.
 */
export function findModesForTool(
  toolName: string,
  definitions: ModeCatalogMap,
  input?: unknown,
  globalBashPatterns?: BashPatternConfig,
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

    // For bash, check policy directly via the pattern engine (no cycle with evaluateToolCall)
    if (toolName === "bash") {
      const bashPolicy = resolveBashPolicy(mode, def as ModeDefinition);
      const patterns = resolveBashPatterns(globalBashPatterns, def.bash_patterns);
      const command = commandFromInput(input);
      if (!isBashCommandAllowed(command, bashPolicy, patterns)) {
        continue;
      }
    }

    result.push(mode);
  }

  return result;
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

export function evaluateToolCall({ 
  mode, 
  definition, 
  toolName, 
  input, 
  catalog, 
  availableAgents,
  bashPatterns,
  globalBashPatterns,
  modeBashPatterns,
}: ModeToolPolicyInput): ModeToolPolicyDecision {
  const suggestedModes = catalog ? findModesForTool(toolName, catalog, input, globalBashPatterns) : undefined;

  // Resolve patterns: pre-resolved takes precedence, otherwise resolve from raw configs
  const resolvedPatterns = bashPatterns ?? resolveBashPatterns(globalBashPatterns, modeBashPatterns);
  
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
      const patterns = resolvedPatterns;
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
    const patterns = resolvedPatterns;

    // Check severity overrides first
    const severityCheck = checkBashSeverity(command, patterns);
    if (severityCheck) {
      if (severityCheck.severity === "block") {
        return {
          block: true,
          reason: `${mode.toUpperCase()} mode blocked command: ${command}\nMatched pattern "${severityCheck.matchedPattern}" with severity: block`,
          suggestedModes,
        };
      }
      if (severityCheck.severity === "ask") {
        return {
          block: false,
          ask: true,
          askMessage: `⚠️ Risky command in ${mode.toUpperCase()} mode\n\nCommand: ${command}\nMatched: ${severityCheck.matchedPattern} — severity: ask`,
          suggestedModes,
        };
      }
      if (severityCheck.severity === "allow") {
        // Explicitly allowed — skip all further bash checks
        return { block: false, suggestedModes };
      }
    }

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
