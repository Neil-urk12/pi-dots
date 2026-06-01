import path from "node:path";
import os from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

import { loadAllModes, notifyModeCatalogDiagnostics, type ModeCatalog } from "./mode-catalog.js";
import { ModeRuntimeController, type ModeRuntimeDecision } from "./mode-runtime.js";
import { injectIntoPayload } from "./payload-injection.js";
import { evaluateToolCall, resolveBashPatterns } from "./mode-tool-policy.js";
import { ModeFileWatcher } from "./mode-file-watcher.js";
import type { ModeDefinition } from "./types.js";
import { PICKER_FALLBACK_MODE, MAX_MODE_NAME_LENGTH, SUFFIX_PREVIEW_LENGTH, USER_CONFIG_DIR, USER_CONFIG_FILE } from "./types.js";

import type { Mode } from "./types.js";

/** Max one-shot bypass entries per session (prevents unbounded growth). */
const MAX_BYPASS_SIZE = 100;

/** Typed interface for the subagent extension's global bridge. */
interface SubagentBridge {
  getAgents(): (string | { name: string })[];
}

export interface ModeSelectOption {
  name: string;
  description?: string;
}

/** Generate a unique key for a tool call to support one-shot bypasses. */
function makeBypassKey(toolName: string, input: unknown): string {
  let args = "";
  if (input && typeof input === "object") {
    try {
      args = JSON.stringify(input, Object.keys(input as Record<string, unknown>).sort());
    } catch {
      args = "<unserializable>";
    }
  }
  return `${toolName}:${args}`;
}

export class ModeSessionCoordinator {
  private runtime: ModeRuntimeController | undefined;
  private readonly fileWatcher: ModeFileWatcher;
  private reloadPending = false;
  private ctx: ExtensionContext | undefined;
  private _sessionId: string | undefined;
  private readonly _oneShotBypasses = new Set<string>();

  constructor(
    private readonly pi: ExtensionAPI,
    baseDir: string,
  ) {
    this.fileWatcher = new ModeFileWatcher(
      path.join(baseDir, "..", "modes"),
      path.join(os.homedir(), USER_CONFIG_DIR, USER_CONFIG_FILE),
    );
  }

  async initialize(ctx: ExtensionContext, sessionId?: string): Promise<void> {
    this.ctx = ctx;
    this._sessionId = sessionId;
    this._oneShotBypasses.clear();
    const catalog = await this.loadCatalog(ctx);
    if (catalog) {
      this.runtime = new ModeRuntimeController(catalog);
    }
  }

  get sessionId(): string | undefined {
    return this._sessionId;
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

    const modes = this.modes();
    const options: ModeSelectOption[] = modes.map(m => ({
      name: m,
      description: this.runtime?.definition(m)?.description,
    }));
    const selectedName = await selectMode(options);
    if (!selectedName) return undefined;

    const mode = modes.find(m => m.toLowerCase() === selectedName) || PICKER_FALLBACK_MODE;
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

  async evaluateToolCall(toolName: string, input: unknown): Promise<{ block: boolean; reason?: string; warning?: string; suggestedModes?: string[] } | undefined> {
    this.runtime?.transition({ type: "tool_call", toolName });
    const mode = this.currentMode();
    const catalogDefs = this.runtime?.catalogDefinitions();
    const availableAgents = this.discoverAvailableAgents();
    const definition = this.runtime?.definition();

    // Check one-shot bypass: if user previously allowed this exact tool call, let it through
    const bypassKey = makeBypassKey(toolName, input);
    if (this._oneShotBypasses.has(bypassKey)) {
      this._oneShotBypasses.delete(bypassKey);
      return { block: false };
    }
    
    const globalBashPatterns = this.runtime?.globalBashPatterns();
    const modeBashPatterns = definition?.bash_patterns;
    const bashPatterns = resolveBashPatterns(globalBashPatterns, modeBashPatterns);
    
    const decision = evaluateToolCall({
      mode,
      definition,
      toolName,
      input,
      catalog: catalogDefs,
      availableAgents,
      bashPatterns,
    });

    // Handle ask action - prompt user for confirmation
    if (decision.ask) {
      if (!this.ctx) {
        return { block: true, reason: `Cannot confirm tool "${toolName}": UI not initialized` };
      }
      if (decision.warning) {
        this.ctx.ui.notify(decision.warning, "warning");
      }
      const message = decision.askMessage ?? `Allow tool "${toolName}" in ${mode.toUpperCase()} mode?`;
      const confirmed = await this.ctx.ui.confirm("Permission Request", message);
      if (!confirmed) {
        return { block: true, reason: `User denied tool: ${toolName}`, warning: decision.warning };
      }
      return { block: false, suggestedModes: decision.suggestedModes, warning: decision.warning };
    }

    if (decision.block && decision.suggestedModes && decision.suggestedModes.length > 0) {
      if (decision.warning) {
        this.ctx?.ui.notify(decision.warning, "warning");
      }

      if (!this.ctx) {
        const suggestions = decision.suggestedModes.join(", ");
        return {
          block: true,
          reason: `${decision.reason}\n\nTo use this tool, switch to: ${suggestions}. Call request_mode_switch({ mode: "<mode>" }).`,
          warning: decision.warning,
        };
      }

      // Show 3-option dialog: Allow once, Switch mode, Deny
      const suggestions = decision.suggestedModes.join(", ");
      const labels = [
        `Allow once — run "${toolName}" this time without switching mode`,
        `Switch mode — change to ${suggestions} (permanent until changed)`,
        "Deny — block this tool call",
      ];
      const choice = await this.ctx.ui.select("Tool blocked by mode policy", labels);

      if (!choice || choice.startsWith("Deny")) {
        return {
          block: true,
          reason: `${decision.reason}\n\nTo use this tool, switch to: ${suggestions}. Call request_mode_switch({ mode: "<mode>" }).`,
          warning: decision.warning,
        };
      }

      if (choice.startsWith("Allow once")) {
        if (this._oneShotBypasses.size >= MAX_BYPASS_SIZE) {
          const oldest = this._oneShotBypasses.values().next().value;
          if (oldest) this._oneShotBypasses.delete(oldest);
        }
        this._oneShotBypasses.add(bypassKey);
        this.ctx.ui.notify(`Allowed "${toolName}" once`, "info");
        return { block: false, warning: decision.warning };
      }

      if (choice.startsWith("Switch mode")) {
        const switchResult = this.switchMode(decision.suggestedModes![0]);
        if (switchResult.ok) {
          return { block: false, warning: decision.warning };
        }
        return {
          block: true,
          reason: `Mode switch failed: ${switchResult.error}. ${decision.reason}`,
          warning: decision.warning,
        };
      }
    }

    if (decision.warning) {
      this.ctx?.ui.notify(decision.warning, "warning");
    }

    return decision;
  }

  buildPromptInjection(): string | undefined {
    const mode = this.currentMode();
    const promptSuffix = this.runtime?.currentPromptSuffix();
    const base = promptSuffix ? `\n\n[MODE: ${mode.toUpperCase()}]\n${promptSuffix}` : `\n\n[MODE: ${mode.toUpperCase()}]`;

    const definition = this.runtime?.definition();
    const hasRestrictions = (definition?.enabled_tools && definition.enabled_tools.length > 0) || (definition?.bash_policy && definition.bash_policy !== "off");
    if (!hasRestrictions) return promptSuffix ? base : undefined;

    let injection = base;

    if (mode === "orchestrator" || (definition?.allowed_agents && definition.allowed_agents.length > 0)) {
      const available = this.discoverAvailableAgents();
      const allowed = definition?.allowed_agents;
      const agents = allowed && allowed.length > 0
        ? available.filter(a => allowed.some(entry => entry.toLowerCase() === a.toLowerCase()))
        : available;
      if (agents.length > 0) {
        injection += `\n\n[AGENTS] Available subagents: ${agents.join(", ")}`;
      }
    }

    const hint = `\n[GUARD] If a tool call is blocked, the error will suggest which mode to switch to. Use request_mode_switch({ mode: "<mode>" }) to switch, then retry the tool call.`;
    return injection + hint;
  }

  beforeProviderRequest(payload: unknown): unknown {
    const injection = this.buildPromptInjection();
    if (!injection) return payload;
    return injectIntoPayload(payload, injection);
  }

  turnEnd(): void {
    if (!this._sessionId) return;
    const decision = this.runtime?.transition({ type: "turn_end" });
    this.applyDecision(decision);
  }

  currentMode(): Mode {
    return this.runtime?.snapshot().currentMode ?? PICKER_FALLBACK_MODE;
  }

  currentDefinition(): ModeDefinition | undefined {
    return this.runtime?.definition();
  }

  modes(): Mode[] {
    return this.runtime?.modes() ?? [];
  }

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

  switchMode(targetMode: string): { ok: boolean; mode?: string; error?: string } {
    if (!this.runtime) return { ok: false, error: "Mode catalog not initialized" };
    if (!targetMode || typeof targetMode !== "string" || targetMode.length > MAX_MODE_NAME_LENGTH) return { ok: false, error: "Invalid mode name" };
    const decision = this.runtime.transition({ type: "mode_select", requestedMode: targetMode });
    if (decision.error) return { ok: false, error: decision.error };
    this.applyDecision(decision);
    this.updateStatus();
    if (decision.modeChanged && this.ctx) this.ctx.ui.notify(`Mode switched: ${this.currentMode().toUpperCase()}`, "info");
    return { ok: true, mode: this.currentMode() };
  }

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
    this.pi.appendEntry("mode-state", { mode: this.currentMode(), sessionId: this._sessionId });
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
    const suffixPreview = (def?.prompt_suffix || "").slice(0, SUFFIX_PREVIEW_LENGTH) + (def?.prompt_suffix && def.prompt_suffix.length > SUFFIX_PREVIEW_LENGTH ? "..." : "");

    const status = `Mode: ${mode}\nDescription: ${def?.description || "—"}\nActive tools (${activeTools.length}): ${activeTools.join(", ")}\nPrompt suffix: ${suffixPreview || "(none)"}\nBorder: ${def?.border_label || ""} (style: ${def?.border_style || "—"})`;
    this.ctx.ui.notify(status, "info");
  }

  private discoverAvailableAgents(): string[] {
    try {
      const bridge = (globalThis as Record<string, unknown>).__pi_subagents as SubagentBridge | undefined;
      if (bridge && typeof bridge.getAgents === "function") {
        const agents = bridge.getAgents();
        if (Array.isArray(agents)) {
          return agents.map(a => typeof a === "string" ? a : a.name).filter(Boolean);
        }
      }
    } catch {
      // bridge not available
    }
    return [];
  }
}

export function lastSessionMode(ctx: ExtensionContext, sessionId?: string): string | undefined {
  const entries = ctx.sessionManager.getEntries()
    .filter((e) => e.type === "custom" && e.customType === "mode-state");
  
  if (sessionId) {
    const sessionEntries = entries.filter((e) => 
      "data" in e && e.data && typeof e.data === "object" && 
      "sessionId" in e.data && (e.data as { sessionId: unknown }).sessionId === sessionId
    );
    const sessionEntry = sessionEntries[sessionEntries.length - 1];
    if (sessionEntry && "data" in sessionEntry && sessionEntry.data && typeof sessionEntry.data === "object" && "mode" in sessionEntry.data && typeof (sessionEntry.data as { mode: unknown }).mode === "string") {
      return (sessionEntry.data as { mode: string }).mode;
    }
  }
  
  const last = entries.pop();
  if (last && "data" in last && last.data && typeof last.data === "object" && "mode" in last.data && typeof (last.data as { mode: unknown }).mode === "string") {
    return (last.data as { mode: string }).mode;
  }
  return undefined;
}
