import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { loadAllModes, notifyModeCatalogDiagnostics, type ModeCatalog } from "./mode-catalog.js";
import { ModeRuntimeController, type ModeRuntimeEffects } from "./mode-runtime.js";
import { injectIntoPayload } from "./payload-injection.js";
import { evaluateToolCall } from "./mode-tool-policy.js";

type Mode = string;


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

    return injectIntoPayload(event.payload, injection);
  });

  // Gate tool access based on mode policy module
  pi.on("tool_call", async (event, _ctx) => {
    const mode = currentMode();
    const decision = evaluateToolCall({
      mode,
      definition: runtime?.definition(),
      toolName: event.toolName,
      input: event.input,
    });

    if (decision.block) {
      return {
        block: true,
        reason: decision.reason,
      };
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
