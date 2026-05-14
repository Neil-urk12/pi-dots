import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import { loadAllModes, notifyModeCatalogDiagnostics, type ModeCatalog } from "./mode-catalog.js";
import { ModeRuntimeController, type ModeRuntimeDecision } from "./mode-runtime.js";
import { injectIntoPayload } from "./payload-injection.js";
import { evaluateToolCall } from "./mode-tool-policy.js";
import { ModeFileWatcher } from "./mode-file-watcher.js";

type Mode = string;


async function loadInitialModeCatalog(ctx?: ExtensionContext): Promise<ModeCatalog | undefined> {
  const result = await loadAllModes();
  if (result.ok) {
    if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    return result.catalog;
  }

  if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
  console.error("[pi-agent-modes] Failed to load required mode definitions", result.diagnostics);
  return undefined;
}

export default async function (pi: ExtensionAPI) {
  let initialCatalog = await loadInitialModeCatalog();
  let runtime = initialCatalog ? new ModeRuntimeController(initialCatalog) : undefined;
  let currentCtx: ExtensionContext | undefined;
  let reloadPending = false;
  const path = await import("path");
  const os = await import("os");
  const { fileURLToPath } = await import("url");
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const fileWatcher = new ModeFileWatcher(
    path.join(baseDir, "..", "modes"),
    path.join(os.homedir(), ".pi", "modes", "config.yaml"),
  );

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

  function applyDecision(decision: ModeRuntimeDecision | undefined, ctx?: ExtensionContext): void {
    if (!decision) return;
    pi.setActiveTools(decision.activeTools);
    if (decision.persistModeState) persistMode();
    if (ctx && decision.notifications.length > 0) {
      for (const item of decision.notifications) {
        ctx.ui.notify(item.message, item.level);
      }
    }
  }

  async function reloadAll(ctx: ExtensionContext): Promise<void> {
    const result = await loadAllModes();
    if (result.ok) {
      if (!runtime) runtime = new ModeRuntimeController(result.catalog);
      const decision = runtime.transition({ type: "mode_reload_result", catalog: result.catalog });
      notifyModeCatalogDiagnostics(ctx, result.diagnostics);
      applyDecision(decision, ctx);
      updateStatus(ctx);
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
      const changed = await fileWatcher.hasChanges(runtime.lastLoadTime());
      if (changed) await reloadAll(ctx);
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
      const decision = runtime.transition({ type: "mode_select", requestedMode: command });
      if (decision.error) {
        ctx.ui.notify(decision.error, "error");
        return;
      }
      applyDecision(decision, ctx);
      updateStatus(ctx);
      if (decision.modeChanged) ctx.ui.notify(`Mode: ${command.toUpperCase()}`, "info");
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
      const decision = runtime.transition({ type: "mode_select", requestedMode: mode });
      if (!decision.error) {
        applyDecision(decision, ctx);
        updateStatus(ctx);
        if (decision.modeChanged) ctx.ui.notify(`Mode: ${mode.toUpperCase()}`, "info");
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
      const decision = runtime.transition({ type: "mode_cycle" });
      applyDecision(decision, ctx);
      updateStatus(ctx);
      if (decision.modeChanged) ctx.ui.notify(`Mode: ${currentMode().toUpperCase()}`, "info");
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
    runtime?.transition({ type: "tool_call", toolName: event.toolName });
    const mode = currentMode();
    const policyDecision = evaluateToolCall({
      mode,
      definition: runtime?.definition(),
      toolName: event.toolName,
      input: event.input,
    });

    if (policyDecision.block) {
      return {
        block: true,
        reason: policyDecision.reason,
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
    const decision = runtime?.transition({
      type: "session_start",
      cliMode: typeof flag === "string" ? flag : undefined,
      sessionMode: lastSessionMode(ctx),
    });
    applyDecision(decision, ctx);
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
    const decision = runtime?.transition({ type: "turn_end" });
    applyDecision(decision, currentCtx);
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
