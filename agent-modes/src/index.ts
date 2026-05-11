import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import type { ModeDefinition } from "./types.js";
import { getLegacyConfig } from "./legacy-config.js";
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

// Phase 1: markdown-driven mode definitions
const modeDefinitions = new Map<Mode, ModeDefinition>();

async function loadModeFromDisk(mode: Mode, ctx?: ExtensionContext): Promise<ModeDefinition | null> {
  try {
    const fs = (await import("fs")).promises;
    const path = await import("path");
    const baseDir = path.dirname(new URL(import.meta.url).pathname);
    const filePath = path.join(baseDir, "..", "modes", `${mode}.md`);
    const raw = await fs.readFile(filePath, "utf-8");
    // Parse YAML frontmatter
    const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      throw new Error("No YAML frontmatter found");
    }
    const yamlStr = frontmatterMatch[1];
    const yaml = (await import("js-yaml")).default;
    const parsed: any = yaml.load(yamlStr);

    if (parsed.mode !== mode) {
      throw new Error(`Mode field '${parsed.mode}' does not match filename '${mode}'`);
    }

    const def: ModeDefinition = {
      mode: parsed.mode,
      enabled_tools: parsed.enabled_tools,
      prompt_suffix: parsed.prompt_suffix,
      description: parsed.description,
      border_label: parsed.border_label,
      border_style: parsed.border_style,
    };
    return def;
  } catch (err: any) {
    if (ctx) {
      ctx.ui.notify(`Mode '${mode}' config load error: ${err.message}`, "warning");
    }
    console.error(`Failed to load mode '${mode}' from disk:`, err);
    return null;
  }
}

async function loadAllModes(ctx: ExtensionContext): Promise<void> {
  const modes: Mode[] = ["yolo", "plan", "orchestrator"];
  for (const mode of modes) {
    const fromDisk = await loadModeFromDisk(mode, ctx);
    if (fromDisk) {
      modeDefinitions.set(mode, fromDisk);
      console.log(`[pi-modes] Loaded mode config from modes/${mode}.md`);
    } else {
      const legacy = getLegacyConfig(mode);
      modeDefinitions.set(mode, legacy);
      // warning already emitted by loadModeFromDisk
    }
  }
}

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
  async function handleModeCommand(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    if (args && args.trim()) {
      const mode = args.trim().toLowerCase() as Mode;
      if (!["yolo", "plan", "orchestrator"].includes(mode)) {
        ctx.ui.notify(`Invalid mode: ${mode}. Use yolo, plan, or orchestrator`, "error");
        return;
      }
      setMode(mode, ctx);
      return;
    }

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

  pi.registerCommand("mode", {
    description: "Switch tool mode (yolo, plan, orchestrator)",
    handler: async (args, ctx) => {
      await handleModeCommand(args, ctx);
    },
  });

  pi.registerCommand("modes", {
    description: "Alias for /mode",
    handler: async (args, ctx) => {
      await handleModeCommand(args, ctx);
    },
  });

  // Shortcut: cycle mode
  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Cycle modes (yolo → plan → orchestrator)",
    handler: async (ctx) => {
      const modes: Mode[] = ["yolo", "plan", "orchestrator"];
      const curIndex = modes.indexOf(currentMode);
      const next = modes[(curIndex + 1) % modes.length];
      setMode(next, ctx);
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

  // Inject mode prompt on every provider request (compaction-safe)
  pi.on("before_provider_request", async (event) => {
    const promptSuffix = modeDefinitions.get(currentMode)?.prompt_suffix;
    if (!promptSuffix) return;

    function injectIntoPayload(payload: any, text: string): void {
      if (typeof payload.system === "string") {
        payload.system += text;
      } else if (Array.isArray(payload.system)) {
        payload.system.push({ type: "text", text });
      } else if (Array.isArray(payload.messages)) {
        const sysMsg = payload.messages.find((m: any) => m.role === "system");
        if (sysMsg) {
          if (typeof sysMsg.content === "string") sysMsg.content += text;
          else if (Array.isArray(sysMsg.content)) sysMsg.content.push({ type: "text", text });
        } else {
          payload.messages.unshift({ role: "system", content: text });
        }
      }
    }

    injectIntoPayload(event.payload, `\n\n[MODE: ${currentMode.toUpperCase()}]
${promptSuffix}`.trim());
  });

  // Switch mode logic
  function setMode(mode: Mode, ctx: ExtensionContext) {
    if (mode === currentMode) return;
    currentMode = mode;

    applyModeTools(ctx);
    updateStatus(ctx);
    persistMode();
    ctx.ui.notify(`Mode: ${mode.toUpperCase()}`, "info");
  }


  function applyModeTools(ctx: ExtensionContext) {
    // Initialize baseline on first use
    if (baselineTools.length === 0) {
      baselineTools = pi.getAllTools().map((t) => t.name);
    }

    const def = modeDefinitions.get(currentMode);
    const enabled = def?.enabled_tools;
    if (enabled === undefined || enabled.length === 0) {
      pi.setActiveTools(baselineTools);
    } else {
      pi.setActiveTools(enabled);
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

  function persistMode() {
    pi.appendEntry("mode-state", { mode: currentMode });
  }

  // Initialize on session start or resume
  pi.on("session_start", async (_event, ctx) => {
    // Load markdown mode definitions (Phase 1)
    await loadAllModes(ctx);
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
    // Set custom editor to display current mode in chat border
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      class ModeEditor extends CustomEditor {
        override render(width: number): string[] {
          const lines = super.render(width);
          if (lines.length === 0) return lines;

          let label: string;
          switch (currentMode) {
            case "yolo":
              label = " YOLO ";
              break;
            case "plan":
              label = " PLAN ";
              break;
            case "orchestrator":
              label = " ORCH ";
              break;
            default:
              label = "";
          }

          if (label && lines.length > 0) {
            const labelWidth = label.length;
            const dashes = "─".repeat(Math.max(0, width - labelWidth));
            const borderText = label + dashes;
            lines[lines.length - 1] = theme.borderColor(borderText);
          }
          return lines;
        }
      }
      return new ModeEditor(tui, theme, keybindings);
    });
  });

  // Persist after each turn to keep latest
  pi.on("turn_end", async () => {
    persistMode();
    // actually pi.appendEntry is independent
    // persistMode already calls pi.appendEntry
  });
}
