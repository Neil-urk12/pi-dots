import type { BashPolicy, ModeDefinition } from "./types.js";

export type ModeCatalogMap = Map<string, { enabled_tools?: string[]; bash_policy?: BashPolicy; allowed_agents?: string[] }>; 

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
}

export interface ModeToolPolicyDecision {
  block: boolean;
  reason?: string;
  suggestedModes?: string[];  // modes that would allow this tool call
  warning?: string;  // non-blocking config issue (e.g. allowed_agents entry not found in availableAgents)
}

/**
 * Given a tool name (and optional bash command), return which modes from the catalog
 * would allow that tool call.
 */
export function findModesForTool(
  toolName: string,
  definitions: ModeCatalogMap,
  input?: unknown,
): string[] {
  const result: string[] = [];

  for (const [mode, def] of definitions) {
    // Check tool allowlist
    const allowed = def.enabled_tools;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(toolName)) {
      continue; // tool not in this mode's allowlist
    }

    // For delegation tools, also check allowed_agents
    if (toolName === "subagent" || toolName === "Agent") {
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

      if (resolvedPolicy === "strict_readonly" && !isSafeCommand(command)) {
        continue; // bash command not allowed in strict_readonly
      }
      if (resolvedPolicy === "non_destructive" && isDestructiveCommand(command)) {
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

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bchgrp\b/i,
  /\bln\b/i,
  /\btee\b/i,
  /\btruncate\b/i,
  /\bdd\b/i,
  /\bshred\b/i,
  /(^|[^<])>(?!>)/,
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
  /\byarn\s+(add|remove|install|publish)/i,
  /\bpnpm\s+(add|remove|install|publish)/i,
  /\bpip\s+(install|uninstall)/i,
  /\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
  /\bbrew\s+(install|uninstall|upgrade)/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
  /\bcurl\b.*\s-(?:[a-zA-Z]*[oO])(?!\s*-)/i,
  /\bcurl\b.*--output\b/i,
  /\bcurl\b.*--remote-name\b/i,
  /\bcurl\b.*--remote-header-name\b/i,
  /\bcurl\b.*--create-dirs\b/i,
] as const;

const SAFE_PATTERNS = [
  /^\s*cat\b/,
  /^\s*head\b/,
  /^\s*tail\b/,
  /^\s*less\b/,
  /^\s*more\b/,
  /^\s*grep\b/,
  /^\s*find\b/,
  /^\s*ls\b/,
  /^\s*pwd\b/,
  /^\s*echo\b/,
  /^\s*printf\b/,
  /^\s*wc\b/,
  /^\s*sort\b/,
  /^\s*uniq\b/,
  /^\s*diff\b/,
  /^\s*file\b/,
  /^\s*stat\b/,
  /^\s*du\b/,
  /^\s*df\b/,
  /^\s*tree\b/,
  /^\s*which\b/,
  /^\s*whereis\b/,
  /^\s*type\b/,
  /^\s*env\b/,
  /^\s*printenv\b/,
  /^\s*uname\b/,
  /^\s*whoami\b/,
  /^\s*id\b/,
  /^\s*date\b/,
  /^\s*cal\b/,
  /^\s*uptime\b/,
  /^\s*ps\b/,
  /^\s*top\b/,
  /^\s*htop\b/,
  /^\s*free\b/,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
  /^\s*git\s+ls-/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*node\s+--version/i,
  /^\s*python\s+--version/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
] as const;

export function evaluateToolCall({ mode, definition, toolName, input, catalog, availableAgents }: ModeToolPolicyInput): ModeToolPolicyDecision {
  const suggestedModes = catalog ? findModesForTool(toolName, catalog, input) : undefined;
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
      if (!isSafeCommand(command)) {
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
  if (toolName === "subagent" || toolName === "Agent") {
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

    if (bashPolicy === "strict_readonly" && !isSafeCommand(command)) {
      return {
        block: true,
        reason: `${mode.toUpperCase()} mode blocked unsafe command: ${command}\nAllowed read-only commands only.`,
        suggestedModes,
      };
    }

    if (bashPolicy === "non_destructive" && isDestructiveCommand(command)) {
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

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

function isSafeCommand(command: string): boolean {
  return !isDestructiveCommand(command) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}
