import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

type Mode = "yolo" | "plan" | "orchestrator";

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"] as const;

// Destructive command patterns (blocked in plan mode)
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
  /(^|[^<])>(?!>)/, // single redirect
  />>/, // append redirect
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

// Safe read-only command allowlist (plan mode)
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

function isSafeCommand(command: string): boolean {
  const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
  const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
  return !isDestructive && isSafe;
}

const MODE_PROMPTS: Record<Mode, string> = {
  yolo: "",
  plan: `
You are in PLAN MODE — a read-only exploration mode for safe code analysis.

RESTRICTIONS:
- Allowed tools: read, bash, grep, find, ls, questionnaire
- Forbidden tools: edit, write (cannot modify files)
- Bash commands are restricted to an allowlist of read-only commands; destructive commands are automatically blocked.

ACTIONS:
- Explore the codebase deeply using the allowed tools.
- Ask clarifying questions using the questionnaire tool.
- When asked, create a detailed, numbered plan under a "Plan:" header:

Plan:
1. First step
2. Second step
...

DO NOT attempt to make any file changes. Only describe what you would do.
`,
  orchestrator: `
You are in ORCHESTRATOR MODE — act as a coordinator of work.

PRINCIPLES:
- Break complex tasks into subtasks.
- Delegate subtasks using the 'subagent' tool to specialized agents (e.g., coder, reviewer, tester).
- For simple changes that you can do directly, perform them yourself.
- Track progress and synthesize results from subagents.
- Plan first, then orchestrate execution using subagents where beneficial.
`,
};

export default function (pi: ExtensionAPI) {
  // internal state
  let currentMode: Mode = "yolo";
  let baselineTools: string[] = [];
  let initialized: boolean = false;

  // CLI flag: --mode <mode>
  pi.registerFlag("mode", {
    description: "Start in tool mode: yolo, plan, or orchestrator",
    type: "string",
  });

  // commands
  pi.registerCommand("mode", {
    description: "Switch tool mode (yolo, plan, orchestrator)",
    handler: async (args, ctx) => {
      if (args && args.trim()) {
        const mode = args.trim().toLowerCase() as Mode;
        if (!["yolo", "plan", "orchestrator"].includes(mode)) {
          ctx.ui.notify(`Invalid mode: ${mode}. Use yolo, plan, or orchestrator`, "error");
          return;
        }
        setMode(mode, ctx);
      } else {
        // interactive selector
        const choice = await ctx.ui.select("Select mode:", [
          "YOLO (full access, no restrictions)",
          "PLAN (read-only exploration)",
          "ORCHESTRATOR (delegate via subagents)",
        ]);
        let mode: Mode = "yolo";
        if (choice) {
          if (choice.startsWith("PLAN")) mode = "plan";
          else if (choice.startsWith("ORCH")) mode = "orchestrator";
          else mode = "yolo";
          setMode(mode, ctx);
        }
      }
    },
  });

  pi.registerCommand("modes", {
    description: "Alias for /mode",
    handler: async (args, ctx) => {
      const cmd = pi.getCommand("mode");
      if (cmd) cmd.handler(args, ctx);
    },
  });

  // Shortcut to cycle modes
  pi.registerShortcut(Key.ctrlAlt("m"), {
    description: "Cycle through modes",
    handler: async (ctx) => {
      cycleMode(ctx);
    },
  });

  // Permission gate for plan mode (block destructive/bash)
  pi.on("tool_call", async (event, ctx) => {
    if (currentMode !== "plan") return;
    if (event.toolName !== "bash") return;

    const command = event.input.command as string;
    if (!isSafeCommand(command)) {
      return {
        block: true,
        reason: `Plan mode blocked command: ${command}\nUse /mode yolo to allow bash execution.`,
      };
    }
  });

  // Inject system prompt modifications based on mode
  pi.on("before_agent_start", async (event) => {
    const promptSuffix = MODE_PROMPTS[currentMode];
    if (!promptSuffix) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${promptSuffix}`.trim(),
    };
  });

  // Switch mode logic
  function setMode(mode: Mode, ctx: ExtensionContext) {
    if (mode === currentMode) return;
    currentMode = mode;

    applyModeTools(ctx);
    updateStatus(ctx);
    persistMode(ctx);
    ctx.ui.notify(`Mode: ${mode.toUpperCase()}`, "info");
  }

  function cycleMode(ctx: ExtensionContext) {
    const modes: Mode[] = ["yolo", "plan", "orchestrator"];
    const curIndex = modes.indexOf(currentMode);
    const next = modes[(curIndex + 1) % modes.length];
    setMode(next, ctx);
  }

  function applyModeTools(ctx: ExtensionContext) {
    // Initialize baseline on first use
    if (baselineTools.length === 0) {
      baselineTools = pi.getAllTools().map((t) => t.name);
    }

    if (currentMode === "plan") {
      pi.setActiveTools(PLAN_TOOLS as string[]);
    } else {
      // yolo or orchestrator — restore full toolset
      pi.setActiveTools(baselineTools);
    }
  }

  function updateStatus(ctx: ExtensionContext) {
    let label: string;
    let style: "accent" | "warning" | "success" | "muted";
    let display: string;

    if (currentMode === "yolo") {
      label = "⚡YOLO";
      style = "success";
      display = label;
    } else if (currentMode === "plan") {
      label = "📋PLAN";
      style = "warning";
      display = label;
    } else if (currentMode === "orchestrator") {
      label = "🤝ORCH";
      style = "accent";
      display = label;
    } else {
      style = "muted";
      display = "";
    }

    if (display) {
      ctx.ui.setStatus("mode", ctx.ui.theme.fg(style, display));
    } else {
      ctx.ui.setStatus("mode", undefined);
    }
  }

  function persistMode(_ctx: ExtensionContext) {
    pi.appendEntry("mode-state", { mode: currentMode });
  }

  // Initialize on session start or resume
  pi.on("session_start", async (_event, ctx) => {
    // capture baseline tool set once
    if (baselineTools.length === 0) {
      baselineTools = pi.getAllTools().map((t) => t.name);
    }

    // check --mode flag
    const flag = pi.getFlag("mode");
    if (typeof flag === "string" && ["yolo", "plan", "orchestrator"].includes(flag)) {
      currentMode = flag as Mode;
    } else {
      // restore from previous session if any
      const entries = ctx.sessionManager.getEntries();
      const last = entries
        .filter((e) => e.type === "custom" && e.customType === "mode-state")
        .pop();
      if (last && "data" in last && last.data && typeof last.data === "object" && "mode" in last.data) {
        const m = (last.data as { mode: string }).mode;
        if (["yolo", "plan", "orchestrator"].includes(m)) {
          currentMode = m as Mode;
        }
      }
    }

    applyModeTools(ctx);
    updateStatus(ctx);
  });

  // Persist after each turn to keep latest
  pi.on("turn_end", async () => {
    persistMode(/*ctx, can't get here? we don't have ctx but pi.appendEntry doesn't need ctx*/);
    // actually pi.appendEntry is independent
    pi.appendEntry("mode-state", { mode: currentMode });
  });
}
