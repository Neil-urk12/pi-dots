import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { loadAllModes, notifyModeCatalogDiagnostics, type ModeCatalog } from "./mode-catalog.js";
import { ModeRuntimeController, type ModeRuntimeEffects } from "./mode-runtime.js";

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

async function loadInitialModeCatalog(ctx?: ExtensionContext): Promise<ModeCatalog | undefined> {
  const result = await loadAllModes();
  if (result.ok) {
    if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    return result.catalog;
  }

  if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
  console.error("[pi-modes] Failed to load required mode definitions", result.diagnostics);
  return undefined;
}

export default async function (pi: ExtensionAPI) {
  let initialCatalog = await loadInitialModeCatalog();
  let runtime = initialCatalog ? new ModeRuntimeController(initialCatalog) : undefined;
  let currentCtx: ExtensionContext | undefined;
  let reloadPending = false;

  // CLI flag: --mode <mode>
  pi.registerFlag("mode", {
    description: "Start in tool mode (e.g. yolo, plan, code, ask, orchestrator)",
    type: "string",
  });

  function currentMode(): Mode {
    return runtime?.snapshot().currentMode ?? "yolo";
  }

  function currentModes(): Mode[] {
    return runtime?.modes() ?? [];
  }

  function applyEffects(effects?: ModeRuntimeEffects): void {
    if (!effects) return;
    pi.setActiveTools(effects.activeTools);
    if (effects.persist) persistMode();
  }

  async function reloadAll(ctx: ExtensionContext): Promise<void> {
    const result = await loadAllModes();
    if (result.ok) {
      if (!runtime) runtime = new ModeRuntimeController(result.catalog);
      const reload = runtime.acceptCatalog(result.catalog);
      notifyModeCatalogDiagnostics(ctx, result.diagnostics);
      applyEffects(reload.effects);
      updateStatus(ctx);
      if (reload.fallbackMode) {
        ctx.ui.notify(`Mode definitions reloaded; current mode missing, fell back to ${reload.fallbackMode.toUpperCase()}`, "warning");
      } else {
        ctx.ui.notify("Mode definitions reloaded", "info");
      }
      return;
    }

    runtime?.keepCatalog();
    notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    ctx.ui.notify(runtime ? "Mode reload failed; keeping previous known-good catalog" : "Mode reload failed; no known-good catalog loaded", runtime ? "warning" : "error");
  }

  async function checkAndReload(ctx: ExtensionContext): Promise<void> {
    if (reloadPending || !runtime) return;
    reloadPending = true;
    try {
      const fs = (await import("fs")).promises;
      const path = await import("path");
      const os = await import("os");
      const baseDir = path.dirname(new URL(import.meta.url).pathname);
      const modesDir = path.join(baseDir, "..", "modes");
      const configPath = path.join(os.homedir(), ".pi", "modes", "config.yaml");
      const lastLoadTime = runtime.lastLoadTime();

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

      if (shouldReload) await reloadAll(ctx);
    } finally {
      reloadPending = false;
    }
  }

  async function handleModeCommand(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    currentCtx = ctx;
    if (!runtime) {
      ctx.ui.notify("Mode catalog not initialized", "error");
      return;
    }

    const command = args?.trim().toLowerCase();
    if (command === "reload") {
      await reloadAll(ctx);
      return;
    }

    if (command === "status") {
      await showModeStatus(ctx);
      return;
    }

    if (command) {
      const result = runtime.setMode(command);
      if (!result.ok) {
        ctx.ui.notify(result.error ?? `Invalid mode: ${command}`, "error");
        return;
      }
      applyEffects(result.effects);
      updateStatus(ctx);
      if (result.effects?.modeChanged) ctx.ui.notify(`Mode: ${command.toUpperCase()}`, "info");
      return;
    }

    const modes = currentModes();
    const options = modes.map(m => {
      const def = runtime?.definition(m);
      const name = m.toUpperCase();
      return def?.description ? `${name} — ${def.description}` : name;
    });
    const choice = await ctx.ui.select("Select mode:", options);

    if (choice) {
      const selectedName = choice.split(" — ")[0].toLowerCase();
      const mode = modes.find(m => m.toLowerCase() === selectedName) || "yolo";
      const result = runtime.setMode(mode);
      if (result.ok) {
        applyEffects(result.effects);
        updateStatus(ctx);
        if (result.effects?.modeChanged) ctx.ui.notify(`Mode: ${mode.toUpperCase()}`, "info");
      }
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
      if (!runtime) return;
      const effects = runtime.cycleMode();
      applyEffects(effects);
      updateStatus(ctx);
      if (effects.modeChanged) ctx.ui.notify(`Mode: ${currentMode().toUpperCase()}`, "info");
    },
  });

  function modePromptInjection(): string | undefined {
    const mode = currentMode();
    const promptSuffix = runtime?.currentPromptSuffix();
    if (!promptSuffix) return undefined;
    return `\n\n[MODE: ${mode.toUpperCase()}]\n${promptSuffix}`;
  }

  // Inject mode prompt on every provider request (compaction-safe).
  pi.on("before_provider_request", async (event) => {
    const injection = modePromptInjection();
    if (!injection) return;

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

    injectIntoPayload(event.payload, injection);
  });

  // Gate tool access based on mode's enabled_tools, plus bash safety in restricted modes
  pi.on("tool_call", async (event, ctx) => {
    const mode = currentMode();
    const def = runtime?.definition();
    const allowed = def?.enabled_tools;
    // Defensive: if mode definition missing (not loaded yet), block editing tools
    if (!def) {
      if (["write", "edit", "apply_patch"].includes(event.toolName)) {
        return {
          block: true,
          reason: `Mode '${mode}' not initialized — editing blocked`
        };
      }
    }

    // If mode has an explicit allowlist (non-empty), enforce it
    if (Array.isArray(allowed) && allowed.length > 0) {
      if (!allowed.includes(event.toolName)) {
        return {
          block: true,
          reason: `${mode.toUpperCase()} mode blocks tool: ${event.toolName}. Allowed tools: ${allowed.join(", ")}`
        };
      }
    }

    // Extra safety: in plan/ask mode, gate bash commands by safety
    if ((mode === "plan" || mode === "ask") && event.toolName === "bash") {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan/Ask mode blocked unsafe command: ${command}\nAllowed read-only commands only. Use /mode yolo to enable full bash.`
        };
      }
    }

    // Code mode: block destructive bash commands (allow non-destructive)
    if (mode === "code" && event.toolName === "bash") {
      const command = event.input.command as string;
      if (isDestructiveCommand(command)) {
        return {
          block: true,
          reason: `CODE mode blocked destructive command: ${command}\nAllowed development commands only. Switch to YOLO (/mode yolo) if you need this.`
        };
      }
    }
  });

  function captureBaselineTools(): void {
    runtime?.captureBaselineTools(pi.getAllTools().map((t) => t.name));
  }

  function updateStatus(ctx: ExtensionContext): void {
    const mode = currentMode();
    const def = runtime?.definition();
    const style = def?.border_style || "muted";

    let display = mode.toUpperCase();
    // Keep legacy emojis for standard modes
    if (mode === "plan") display = "📋PLAN";
    else if (mode === "orchestrator") display = "🤝ORCH";
    else if (mode === "ask") display = "❓ASK";

    ctx.ui.setStatus("mode", ctx.ui.theme.fg(style, display));
  }

  function persistMode(): void {
    pi.appendEntry("mode-state", { mode: currentMode() });
  }

  // Initialize on session start or resume
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    initialCatalog = await loadInitialModeCatalog(ctx) ?? initialCatalog;
    if (initialCatalog) {
      if (!runtime) runtime = new ModeRuntimeController(initialCatalog);
      else runtime.acceptCatalog(initialCatalog);
    }

    captureBaselineTools();
    const flag = pi.getFlag("mode");
    const effects = runtime?.restore({
      cliMode: typeof flag === "string" ? flag : undefined,
      sessionMode: lastSessionMode(ctx),
    });
    applyEffects(effects);
    updateStatus(ctx);

    // Set custom editor to display current mode in chat border
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      class ModeEditor extends CustomEditor {
        override render(width: number): string[] {
          const lines = super.render(width);
          if (lines.length === 0) return lines;

          const mode = currentMode();
          const def = runtime?.definition();
          let label = def?.border_label || ` ${mode.toUpperCase()} `;
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
    if (currentCtx) await checkAndReload(currentCtx);
  });

  async function showModeStatus(ctx: ExtensionContext): Promise<void> {
    const mode = currentMode();
    const def = runtime?.definition();
    const allTools = pi.getAllTools().map(t => t.name);
    const activeTools = runtime?.activeTools() ?? allTools;
    const suffixPreview = (def?.prompt_suffix || "").slice(0, 120) + (def?.prompt_suffix && def.prompt_suffix.length > 120 ? "..." : "");

    const status = `Mode: ${mode}\nDescription: ${def?.description || "—"}\nActive tools (${activeTools.length}): ${activeTools.join(", ")}\nPrompt suffix: ${suffixPreview || "(none)"}\nBorder: ${def?.border_label || ""} (style: ${def?.border_style || "—"})`;

    ctx.ui.notify(status, "info");
  }
}

function lastSessionMode(ctx: ExtensionContext): string | undefined {
  const last = ctx.sessionManager.getEntries()
    .filter((e) => e.type === "custom" && e.customType === "mode-state")
    .pop();
  if (last && "data" in last && last.data && typeof last.data === "object" && "mode" in last.data) {
    return (last.data as { mode: string }).mode;
  }
  return undefined;
}
