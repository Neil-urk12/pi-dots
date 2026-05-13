import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import type { ModeDefinition } from "./types.js";
import { loadAllModes, notifyModeCatalogDiagnostics, type ModeCatalog } from "./mode-catalog.js";
type Mode = string;

// Plan mode bash command filtering
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

function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some(p => p.test(command));
}

function isSafeCommand(command: string): boolean {
  return !isDestructiveCommand(command) && SAFE_PATTERNS.some(p => p.test(command));
}

let activeCatalog: ModeCatalog | null = null;
let lastLoadTime = 0;

// Phase 1: markdown-driven mode definitions
const modeDefinitions = new Map<Mode, ModeDefinition>();

function replaceActiveCatalog(catalog: ModeCatalog): void {
  activeCatalog = catalog;
  modeDefinitions.clear();
  for (const [mode, definition] of catalog.definitions) {
    modeDefinitions.set(mode, definition);
  }
  lastLoadTime = catalog.loadedAt;
}

async function loadInitialModeCatalog(ctx?: ExtensionContext): Promise<void> {
  const result = await loadAllModes();
  if (result.ok) {
    replaceActiveCatalog(result.catalog);
    if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    return;
  }

  if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
  console.error("[pi-modes] Failed to load required mode definitions", result.diagnostics);
}

export default async function (pi: ExtensionAPI) {
  // internal state
  let currentMode: Mode = "yolo";
  let baselineTools: string[] = [];
  let initialized: boolean = false;
  await loadInitialModeCatalog();

  // CLI flag: --mode <mode>
  pi.registerFlag("mode", {
    description: "Start in tool mode (e.g. yolo, plan, code, ask, orchestrator)",
    type: "string",
  });

  // commands
  let currentCtx: ExtensionContext | undefined;

  async function reloadAll(ctx: ExtensionContext): Promise<void> {
    const result = await loadAllModes();
    if (result.ok) {
      replaceActiveCatalog(result.catalog);
      notifyModeCatalogDiagnostics(ctx, result.diagnostics);
      applyModeTools(ctx);
      updateStatus(ctx);
      ctx.ui.notify("Mode definitions reloaded", "info");
      return;
    }

    notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    ctx.ui.notify(activeCatalog ? "Mode reload failed; keeping previous known-good catalog" : "Mode reload failed; no known-good catalog loaded", activeCatalog ? "warning" : "error");
  }

  let reloadPending = false;
  async function checkAndReload(ctx: ExtensionContext): Promise<void> {
    if (reloadPending) return;
    reloadPending = true;
    try {
      const fs = (await import("fs")).promises;
      const path = await import("path");
      const os = await import("os");
      const baseDir = path.dirname(new URL(import.meta.url).pathname);
      const modesDir = path.join(baseDir, "..", "modes");
      const configPath = path.join(os.homedir(), ".pi", "modes", "config.yaml");

      let shouldReload = false;

      try {
        const st = await fs.stat(configPath);
        if (st.mtimeMs > lastLoadTime) shouldReload = true;
      } catch (e) {}

      if (!shouldReload) {
        try {
          const files = await fs.readdir(modesDir);
          for (const file of files) {
            if (file.endsWith(".md")) {
              const st = await fs.stat(path.join(modesDir, file));
              if (st.mtimeMs > lastLoadTime) {
                shouldReload = true;
                break;
              }
            }
          }
        } catch (e) {}
      }

      if (shouldReload) {
        await reloadAll(ctx);
      }
    } finally {
      reloadPending = false;
    }
  }

  async function handleModeCommand(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    currentCtx = ctx;
    // reload subcommand
    if (args && args.trim().toLowerCase() === "reload") {
      await reloadAll(ctx);
      return;
    }

    // status subcommand
    if (args && args.trim().toLowerCase() === "status") {
      await showModeStatus(ctx);
      return;
    }

    if (args && args.trim()) {
      const mode = args.trim().toLowerCase();
      if (!modeDefinitions.has(mode)) {
        ctx.ui.notify(`Invalid mode: ${mode}. Available: ${Array.from(modeDefinitions.keys()).join(", ")}`, "error");
        return;
      }
      setMode(mode, ctx);
      return;
    }

    // interactive selector with mode descriptions
    const modes = Array.from(modeDefinitions.keys());
    const options = modes.map(m => {
      const def = modeDefinitions.get(m);
      const name = m.toUpperCase();
      return def?.description ? `${name} — ${def.description}` : name;
    });
    const choice = await ctx.ui.select("Select mode:", options);

    if (choice) {
      // Extract the mode name from the choice string
      const selectedName = choice.split(" — ")[0].toLowerCase();
      const mode = modes.find(m => m.toLowerCase() === selectedName) || "yolo";
      setMode(mode, ctx);
    }
  }

  pi.registerCommand("mode", {
    description: "Switch tool mode (yolo, plan, code, ask, orchestrator)",
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
    description: "Cycle modes (yolo → plan → code → ask → orchestrator)",
    handler: async (ctx) => {
      const modes = Array.from(modeDefinitions.keys());
      const curIndex = modes.indexOf(currentMode);
      const next = modes[(curIndex + 1) % modes.length];
      setMode(next, ctx);
    },
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
  // Gate tool access based on mode's enabled_tools, plus bash safety in restricted modes
  pi.on("tool_call", async (event, ctx) => {
    const def = modeDefinitions.get(currentMode);
    const allowed = def?.enabled_tools;
    // Defensive: if mode definition missing (not loaded yet), block editing tools
    if (!def) {
      if (["write", "edit", "apply_patch"].includes(event.toolName)) {
        return {
          block: true,
          reason: `Mode '${currentMode}' not initialized — editing blocked`
        };
      }
    }

    // If mode has an explicit allowlist (non-empty), enforce it
    if (Array.isArray(allowed) && allowed.length > 0) {
      if (!allowed.includes(event.toolName)) {
        return {
          block: true,
          reason: `${currentMode.toUpperCase()} mode blocks tool: ${event.toolName}. Allowed tools: ${allowed.join(", ")}`
        };
      }
    }

    // Extra safety: in plan/ask mode, gate bash commands by safety
    if ((currentMode === "plan" || currentMode === "ask") && event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan/Ask mode blocked unsafe command: ${command}\nAllowed read-only commands only. Use /mode yolo to enable full bash.`
        };
      }
    }

    // Code mode: block destructive bash commands (allow non-destructive)
    if (currentMode === "code" && event.toolName === "bash") {
      const command = event.input.command as string;
      if (isDestructiveCommand(command)) {
        return {
          block: true,
          reason: `CODE mode blocked destructive command: ${command}\nAllowed development commands only. Switch to YOLO (/mode yolo) if you need this.`
        };
      }
    }
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
    const def = modeDefinitions.get(currentMode);
    const style = def?.border_style || "muted";
    
    let display = currentMode.toUpperCase();
    // Keep legacy emojis for standard modes
    if (currentMode === "plan") display = "📋PLAN";
    else if (currentMode === "orchestrator") display = "🤝ORCH";
    else if (currentMode === "ask") display = "❓ASK";

    ctx.ui.setStatus("mode", ctx.ui.theme.fg(style, display));
  }

  function persistMode() {
    pi.appendEntry("mode-state", { mode: currentMode });
  }

  // Initialize on session start or resume
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    // Load markdown mode definitions (Phase 1)
    await loadInitialModeCatalog(ctx);
    // capture baseline tool set once
    if (baselineTools.length === 0) {
      baselineTools = pi.getAllTools().map((t) => t.name);
    }

    // check --mode flag
    const flag = pi.getFlag("mode");
    if (typeof flag === "string" && modeDefinitions.has(flag)) {
      currentMode = flag;
    } else {
      // restore from previous session if any
      const entries = ctx.sessionManager.getEntries();
      const last = entries
        .filter((e) => e.type === "custom" && e.customType === "mode-state")
        .pop();
      if (last && "data" in last && last.data && typeof last.data === "object" && "mode" in last.data) {
        const m = (last.data as { mode: string }).mode;
        if (modeDefinitions.has(m)) {
          currentMode = m;
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

          const def = modeDefinitions.get(currentMode);
          let label = def?.border_label || ` ${currentMode.toUpperCase()} `;
          const style = def?.border_style;

          if (label && lines.length > 0) {
            const labelWidth = label.length;
            const dashes = "─".repeat(Math.max(0, width - labelWidth));
            const borderText = label + dashes;
            
            // Apply custom theme color if specified
            if (style && style !== "muted" && typeof ctx.ui.theme.fg === "function") {
               // Use fg color mapped from style, or fallback to borderColor
               lines[lines.length - 1] = ctx.ui.theme.fg(style, borderText);
            } else {
               lines[lines.length - 1] = theme.borderColor(borderText);
            }
          }

          return lines;
        }
      }
      return new ModeEditor(tui, theme, keybindings);
    });
  });

  // Persist after each turn to keep latest
  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx || currentCtx;
    persistMode();
    if (currentCtx) {
      await checkAndReload(currentCtx);
    }
  });

  async function showModeStatus(ctx: ExtensionContext) {
    const def = modeDefinitions.get(currentMode);
    const allTools = pi.getAllTools().map(t => t.name);
    const activeTools = (def?.enabled_tools && def.enabled_tools.length > 0)
      ? def.enabled_tools
      : (baselineTools.length === 0 ? allTools : baselineTools);

    const suffixPreview = (def?.prompt_suffix || "").slice(0, 120) + (def?.prompt_suffix && def.prompt_suffix.length > 120 ? "..." : "");

    const status = `Mode: ${currentMode}\nDescription: ${def?.description || "—"}\nActive tools (${activeTools.length}): ${activeTools.join(", ")}\nPrompt suffix: ${suffixPreview || "(none)"}\nBorder: ${def?.border_label || ""} (style: ${def?.border_style || "—"})`;

    ctx.ui.notify(status, "info");
  }
}
