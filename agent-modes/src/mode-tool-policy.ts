import type { BashPolicy, ModeDefinition } from "./types.js";

export interface ModeToolPolicyInput {
  mode: string;
  definition?: ModeDefinition;
  toolName: string;
  input?: unknown;
}

export interface ModeToolPolicyDecision {
  block: boolean;
  reason?: string;
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
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
  /^\s*jq\b/,
  /^\s*sed\s+-n/i,
  /^\s*awk\b/,
  /^\s*rg\b/,
  /^\s*fd\b/,
  /^\s*bat\b/,
  /^\s*eza\b/,
] as const;

export function evaluateToolCall({ mode, definition, toolName, input }: ModeToolPolicyInput): ModeToolPolicyDecision {
  if (!definition) {
    if (!FAIL_CLOSED_READ_ONLY_TOOLS.has(toolName)) {
      return {
        block: true,
        reason: `Mode '${mode}' not initialized — fail-closed blocks tool: ${toolName}`,
      };
    }

    if (toolName === "bash") {
      const command = commandFromInput(input);
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Mode '${mode}' not initialized — fail-closed blocked unsafe command: ${command}`,
        };
      }
    }

    return { block: false };
  }

  const allowed = definition.enabled_tools;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(toolName)) {
    return {
      block: true,
      reason: `${mode.toUpperCase()} mode blocks tool: ${toolName}. Allowed tools: ${allowed.join(", ")}`,
    };
  }

  if (toolName === "bash") {
    const command = commandFromInput(input);
    const bashPolicy = resolveBashPolicy(mode, definition);

    if (bashPolicy === "strict_readonly" && !isSafeCommand(command)) {
      return {
        block: true,
        reason: `${mode.toUpperCase()} mode blocked unsafe command: ${command}\nAllowed read-only commands only. Use /mode yolo to enable full bash.`,
      };
    }

    if (bashPolicy === "non_destructive" && isDestructiveCommand(command)) {
      return {
        block: true,
        reason: `${mode.toUpperCase()} mode blocked destructive command: ${command}\nAllowed development commands only. Switch to YOLO (/mode yolo) if you need this.`,
      };
    }
  }

  return { block: false };
}

function commandFromInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = (input as { command?: unknown }).command;
  return typeof value === "string" ? value : "";
}

function resolveBashPolicy(mode: string, definition: ModeDefinition): BashPolicy {
  if (definition.bash_policy) return definition.bash_policy;

  const normalized = mode.trim().toLowerCase();
  if (normalized === "plan" || normalized === "ask") return "strict_readonly";
  if (normalized === "code") return "non_destructive";
  return "off";
}

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

function isSafeCommand(command: string): boolean {
  return !isDestructiveCommand(command) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}
