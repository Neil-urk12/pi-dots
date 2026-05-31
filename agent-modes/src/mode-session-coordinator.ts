import path from "node:path";
import os from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

import { loadAllModes, notifyModeCatalogDiagnostics, type ModeCatalog } from "./mode-catalog.js";
import { ModeRuntimeController, type ModeRuntimeDecision } from "./mode-runtime.js";
import { injectIntoPayload } from "./payload-injection.js";
import { evaluateToolCall } from "./mode-tool-policy.js";
import { ModeFileWatcher } from "./mode-file-watcher.js";
import type { ModeDefinition } from "./types.js";

export type Mode = string;

export interface ModeSelectOption {
  name: string;
  description?: string;
}

export class ModeSessionCoordinator {
  private runtime: ModeRuntimeController | undefined;
  private readonly fileWatcher: ModeFileWatcher;
  private reloadPending = false;
  private ctx: ExtensionContext | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    baseDir: string,
  ) {
    this.fileWatcher = new ModeFileWatcher(
      path.join(baseDir, "..", "modes"),
      path.join(os.homedir(), ".pi", "modes", "config.yaml"),
    );
  }

  async initialize(ctx: ExtensionContext): Promise<void> {
    this.ctx = ctx;
    const catalog = await this.loadCatalog(ctx);
    if (catalog) {
      if (!this.runtime) this.runtime = new ModeRuntimeController(catalog);
      else this.runtime.acceptCatalog(catalog);
    }
  }

  private async loadCatalog(ctx?: ExtensionContext): Promise<ModeCatalog | undefined> {
    const result = await loadAllModes();
    if (result.ok) {
      if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
      return result.catalog;
    }
    if (ctx) notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    console.error("[pi-agent-modes] Failed to load required mode definitions", result.diagnostics);
    return undefined;
  }

  // --- Session lifecycle ---

  restoreMode(cliFlag?: string, sessionMode?: string): ModeRuntimeDecision | undefined {
    const decision = this.runtime?.transition({
      type: "session_start",
      cliMode: typeof cliFlag === "string" ? cliFlag : undefined,
      sessionMode,
    });
    this.applyDecision(decision);
    return decision;
  }

  captureBaselineTools(): void {
    this.runtime?.captureBaselineTools(this.pi.getAllTools().map((t) => t.name));
  }

  // --- Reload ---

  async reload(): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const result = await loadAllModes();
    if (result.ok) {
      if (!this.runtime) this.runtime = new ModeRuntimeController(result.catalog);
      const decision = this.runtime.transition({ type: "mode_reload_result", catalog: result.catalog });
      notifyModeCatalogDiagnostics(ctx, result.diagnostics);
      this.applyDecision(decision);
      this.updateStatus();
      return;
    }
    this.runtime?.keepCatalog();
    notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    ctx.ui.notify(
      this.runtime ? "Mode reload failed; keeping previous known-good catalog" : "Mode reload failed; no known-good catalog loaded",
      this.runtime ? "warning" : "error",
    );
  }

  async checkAndReload(): Promise<void> {
    if (this.reloadPending || !this.runtime) return;
    this.reloadPending = true;
    try {
      const changed = await this.fileWatcher.hasChanges(this.runtime.lastLoadTime());
      if (changed) await this.reload();
    } catch (err) {
      console.error("[pi-agent-modes] Error checking for mode file changes:", err);
    } finally {
      this.reloadPending = false;
    }
  }

  // --- Commands ---

  async handleCommand(
    args: string | undefined,
    selectMode: (options: ModeSelectOption[]) => Promise<string | undefined>,
  ): Promise<ModeRuntimeDecision | undefined> {
    if (!this.runtime) {
      this.ctx?.ui.notify("Mode catalog not initialized", "error");
      return undefined;
    }

    const command = args?.trim().toLowerCase();
    if (command === "reload") {
      await this.reload();
      return undefined;
    }
    if (command === "status") {
      this.showStatus();
      return undefined;
    }

    if (command) {
      const decision = this.runtime.transition({ type: "mode_select", requestedMode: command });
      if (decision.error) {
        this.ctx?.ui.notify(decision.error, "error");
        return undefined;
      }
      this.applyDecision(decision);
      this.updateStatus();
      if (decision.modeChanged && this.ctx) this.ctx.ui.notify(`Mode: ${command.toUpperCase()}`, "info");
      return decision;
    }

    // Interactive picker
    const modes = this.modes();
    const options: ModeSelectOption[] = modes.map(m => ({
      name: m,
      description: this.runtime?.definition(m)?.description,
    }));
    const selectedName = await selectMode(options);
    if (!selectedName) return undefined;

    const mode = modes.find(m => m.toLowerCase() === selectedName) || "yolo";
    const decision = this.runtime.transition({ type: "mode_select", requestedMode: mode });
    if (!decision.error) {
      this.applyDecision(decision);
      this.updateStatus();
      if (decision.modeChanged && this.ctx) this.ctx.ui.notify(`Mode: ${mode.toUpperCase()}`, "info");
    }
    return decision;
  }

  cycleMode(): ModeRuntimeDecision | undefined {
    if (!this.runtime) return undefined;
    const decision = this.runtime.transition({ type: "mode_cycle" });
    this.applyDecision(decision);
    this.updateStatus();
    if (decision.modeChanged && this.ctx) this.ctx.ui.notify(`Mode: ${this.currentMode().toUpperCase()}`, "info");
    return decision;
  }

  // --- Hooks ---

  evaluateToolCall(toolName: string, input: unknown): { block: boolean; reason?: string } | undefined {
    this.runtime?.transition({ type: "tool_call", toolName });
    const mode = this.currentMode();
    return evaluateToolCall({
      mode,
      definition: this.runtime?.definition(),
      toolName,
      input,
    });
  }

  buildPromptInjection(): string | undefined {
    const mode = this.currentMode();
    const promptSuffix = this.runtime?.currentPromptSuffix();
    if (!promptSuffix) return undefined;
    return `\n\n[MODE: ${mode.toUpperCase()}]\n${promptSuffix}`;
  }

  beforeProviderRequest(payload: unknown): unknown {
    const injection = this.buildPromptInjection();
    if (!injection) return payload;
    return injectIntoPayload(payload, injection);
  }

  turnEnd(): void {
    const decision = this.runtime?.transition({ type: "turn_end" });
    this.applyDecision(decision);
  }

  // --- State ---

  currentMode(): Mode {
    return this.runtime?.snapshot().currentMode ?? "yolo";
  }

  currentDefinition(): ModeDefinition | undefined {
    return this.runtime?.definition();
  }

  modes(): Mode[] {
    return this.runtime?.modes() ?? [];
  }

  // --- UI ---

  setupEditor(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const self = this;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      class ModeEditor extends CustomEditor {
        override render(width: number): string[] {
          const lines = super.render(width);
          if (lines.length === 0) return lines;

          const mode = self.currentMode();
          const def = self.currentDefinition();
          let label = def?.border_label || ` ${mode.toUpperCase()} `;
          const style = def?.border_style;

          if (label && lines.length > 0) {
            const labelWidth = label.length;
            const dashes = "─".repeat(Math.max(0, width - labelWidth));
            const borderText = label + dashes;

            if (style && style !== "muted" && typeof ctx.ui.theme.fg === "function") {
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
  }

  // --- Private ---

  private applyDecision(decision: ModeRuntimeDecision | undefined): void {
    if (!decision) return;
    this.pi.setActiveTools(decision.activeTools);
    if (decision.persistModeState) this.persistMode();
    if (this.ctx && decision.notifications.length > 0) {
      for (const item of decision.notifications) {
        this.ctx.ui.notify(item.message, item.level);
      }
    }
  }

  private persistMode(): void {
    this.pi.appendEntry("mode-state", { mode: this.currentMode() });
  }

  private updateStatus(): void {
    if (!this.ctx) return;
    const mode = this.currentMode();
    const def = this.currentDefinition();
    const style = def?.border_style || "muted";

    let display = mode.toUpperCase();
    if (mode === "plan") display = "📋PLAN";
    else if (mode === "orchestrator") display = "🤝ORCH";
    else if (mode === "ask") display = "❓ASK";

    this.ctx.ui.setStatus("mode", this.ctx.ui.theme.fg(style, display));
  }

  private showStatus(): void {
    if (!this.ctx) return;
    const mode = this.currentMode();
    const def = this.currentDefinition();
    const allTools = this.pi.getAllTools().map(t => t.name);
    const activeTools = this.runtime?.activeTools() ?? allTools;
    const suffixPreview = (def?.prompt_suffix || "").slice(0, 120) + (def?.prompt_suffix && def.prompt_suffix.length > 120 ? "..." : "");

    const status = `Mode: ${mode}\nDescription: ${def?.description || "—"}\nActive tools (${activeTools.length}): ${activeTools.join(", ")}\nPrompt suffix: ${suffixPreview || "(none)"}\nBorder: ${def?.border_label || ""} (style: ${def?.border_style || "—"})`;
    this.ctx.ui.notify(status, "info");
  }
}

export function lastSessionMode(ctx: ExtensionContext): string | undefined {
  const last = ctx.sessionManager.getEntries()
    .filter((e) => e.type === "custom" && e.customType === "mode-state")
    .pop();
  if (last && "data" in last && last.data && typeof last.data === "object" && "mode" in last.data) {
    return (last.data as { mode: string }).mode;
  }
  return undefined;
}
