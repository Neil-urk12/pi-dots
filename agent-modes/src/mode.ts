import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

import { loadAllModes, notifyModeCatalogDiagnostics, type ModeCatalog } from "./mode-catalog.js";
import { injectIntoPayload } from "./payload-injection.js";
import { evaluateToolCall, resolveBashPatterns } from "./mode-tool-policy.js";
import { ModeFileWatcher } from "./mode-file-watcher.js";
import type { ModeDefinition } from "./types.js";
import { PICKER_FALLBACK_MODE, MAX_MODE_NAME_LENGTH, SUFFIX_PREVIEW_LENGTH, USER_CONFIG_DIR, USER_CONFIG_FILE, DEFAULT_MODE, SAFE_FALLBACK_MODES } from "./types.js";
import { PiModeEffects } from "./mode-effects.js";
import { PiModeDialogs } from "./mode-dialogs.js";

export interface ModeSelectOption {
  name: string;
  description?: string;
}

export interface EvaluateToolCallResult {
  block: boolean;
  reason?: string;
  warning?: string;
  suggestedModes?: string[];
}

/** Fire-and-forget side effects the Mode module produces. */
export interface ModeEffects {
  setActiveTools(tools: string[]): void;
  persistMode(mode: string, sessionId?: string): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus(key: string, display: string): void;
}

/** Interactive queries whose answers shape policy verdicts. */
export interface ModeDialogs {
  confirm(title: string, message: string): Promise<boolean>;
  select(prompt: string, options: string[]): Promise<string | undefined>;
}

/** Narrow read-only view of Mode for rendering (e.g. the editor border). */
export interface ModeStatusReader {
  currentMode(): string;
  currentDefinition(): ModeDefinition | undefined;
}

export interface ModeOptions {
  defaultMode?: string;
  safeFallbackModes?: readonly string[];
}

/** Max one-shot bypass entries per session. */
const MAX_BYPASS_SIZE = 100;

class NullModeEffects implements ModeEffects {
  setActiveTools(): void {}
  persistMode(): void {}
  notify(): void {}
  setStatus(): void {}
}

class NullModeDialogs implements ModeDialogs {
  async confirm(): Promise<boolean> {
    throw new Error("Mode.bindContext(ctx) must be called before dialogs are used");
  }
  async select(): Promise<string | undefined> {
    throw new Error("Mode.bindContext(ctx) must be called before dialogs are used");
  }
}

/** Typed interface for the subagent extension's global bridge. */
interface SubagentBridge {
  getAgents(): (string | { name: string })[];
}

function makeBypassKey(toolName: string, input: unknown): string {
  let args = "";
  if (input && typeof input === "object") {
    try {
      args = JSON.stringify(input, (_key, value) => {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          return Object.keys(value).sort().reduce<Record<string, unknown>>((sorted, k) => {
            sorted[k] = (value as Record<string, unknown>)[k];
            return sorted;
          }, {});
        }
        return value;
      });
    } catch {
      args = "<unserializable>";
    }
  }
  return `${toolName}:${args}`;
}

function normalizeMode(mode?: string): string | undefined {
  const normalized = mode?.trim().toLowerCase();
  return normalized || undefined;
}

export class Mode implements ModeStatusReader {
  private catalog: ModeCatalog | undefined;
  private _currentMode: string;
  private baselineTools: string[] = [];
  private ctx: ExtensionContext | undefined;
  private _sessionId: string | undefined;
  private readonly _oneShotBypasses = new Set<string>();
  private reloadPending = false;
  private effects: ModeEffects = new NullModeEffects();
  private dialogs: ModeDialogs = new NullModeDialogs();
  private readonly defaultMode: string;
  private readonly safeFallbackModes: readonly string[];

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly fileWatcher: ModeFileWatcher,
    options: ModeOptions = {},
  ) {
    this.defaultMode = options.defaultMode ?? DEFAULT_MODE;
    this.safeFallbackModes = options.safeFallbackModes ?? SAFE_FALLBACK_MODES;
    this._currentMode = this.defaultMode;
  }

  bindContext(ctx: ExtensionContext | undefined): void {
    this.ctx = ctx;
    if (ctx) {
      this.effects = new PiModeEffects(this.pi, ctx);
      this.dialogs = new PiModeDialogs(ctx);
    } else {
      this.effects = new NullModeEffects();
      this.dialogs = new NullModeDialogs();
    }
  }

  // ── State queries ────────────────────────────────────────────────

  currentMode(): string {
    return this.catalog ? this._currentMode : PICKER_FALLBACK_MODE;
  }

  currentDefinition(): ModeDefinition | undefined {
    return this.catalog?.definitions.get(this._currentMode);
  }

  modes(): string[] {
    return this.catalog ? Array.from(this.catalog.definitions.keys()) : [];
  }

  definition(mode?: string): ModeDefinition | undefined {
    return this.catalog?.definitions.get(mode ?? this._currentMode);
  }

  sessionId(): string | undefined {
    return this._sessionId;
  }

  catalogDefinitions() {
    return this.catalog?.definitions;
  }

  globalBashPatterns() {
    return this.catalog?.globalBashPatterns;
  }

  activeTools(): string[] {
    const enabled = this.currentDefinition()?.enabled_tools;
    return enabled && enabled.length > 0 ? [...enabled] : [...this.baselineTools];
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async initialize(ctx: ExtensionContext, sessionId?: string): Promise<void> {
    this.bindContext(ctx);
    this._sessionId = sessionId;
    this._oneShotBypasses.clear();

    const result = await loadAllModes();
    if (!result.ok) {
      notifyModeCatalogDiagnostics(ctx, result.diagnostics);
      console.error("[pi-agent-modes] Failed to load required mode definitions", result.diagnostics);
      return;
    }
    notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    this.catalog = result.catalog;
    if (!this._currentMode || !this.catalog.definitions.has(this._currentMode)) {
      this._currentMode = this.catalog.definitions.has(this.defaultMode)
        ? this.defaultMode
        : this.firstAvailableMode();
    }
  }

  /**
   * Read the last persisted mode from session history. Returns undefined when
   * nothing is recorded. Callers must still validate against the loaded catalog.
   */
  restoreFromSession(sessionId?: string): string | undefined {
    if (!this.ctx) return undefined;
    const entries = this.ctx.sessionManager.getEntries()
      .filter((e) => e.type === "custom" && e.customType === "mode-state");

    if (sessionId) {
      const sessionEntries = entries.filter((e) =>
        "data" in e && e.data && typeof e.data === "object" &&
        "sessionId" in e.data && (e.data as { sessionId: unknown }).sessionId === sessionId,
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

  /**
   * Restore a mode using the precedence: CLI flag > derived (session or subagent fallback) > current > safe fallback.
   */
  restore(cliMode?: string, derivedMode?: string): void {
    if (!this.catalog) return;
    const nextMode = this.pickRestoreMode(cliMode, derivedMode);
    const modeChanged = nextMode !== this._currentMode;
    this._currentMode = nextMode;
    this.applyModeChange(modeChanged, false);
  }

  captureBaselineTools(toolNames: string[]): void {
    if (this.baselineTools.length === 0) {
      this.baselineTools = [...toolNames];
    }
  }

  // ── Mode changes ─────────────────────────────────────────────────

  setMode(mode: string): { ok: boolean; mode?: string; error?: string } {
    if (!this.catalog) return { ok: false, error: "Mode catalog not initialized" };
    const requestedMode = normalizeMode(mode);
    if (!requestedMode || !this.catalog.definitions.has(requestedMode)) {
      const message = `Invalid mode: ${mode}. Available: ${this.modes().join(", ")}`;
      this.effects.notify(message, "error");
      return { ok: false, error: message };
    }
    const modeChanged = requestedMode !== this._currentMode;
    this._currentMode = requestedMode;
    this.applyModeChange(modeChanged, modeChanged);
    return { ok: true, mode: this._currentMode };
  }

  cycleMode(): void {
    if (!this.catalog) return;
    const modes = this.modes();
    const curIndex = modes.indexOf(this._currentMode);
    const next = modes[(curIndex + 1) % modes.length] ?? this.firstAvailableMode();
    const modeChanged = next !== this._currentMode;
    this._currentMode = next;
    this.applyModeChange(modeChanged, modeChanged);
  }

  acceptCatalog(catalog: ModeCatalog): void {
    this.catalog = catalog;
    let fallbackMode: string | undefined;
    let modeChanged = false;

    if (!this.catalog.definitions.has(this._currentMode)) {
      fallbackMode = this.safeFallbackMode();
      modeChanged = fallbackMode !== this._currentMode;
      this._currentMode = fallbackMode;
    }

    if (fallbackMode) {
      this.effects.notify(`Mode definitions reloaded; current mode missing, fell back to ${fallbackMode.toUpperCase()}`, "warning");
    } else {
      this.effects.notify("Mode definitions reloaded", "info");
    }

    this.applyModeChange(modeChanged, modeChanged);
  }

  // ── Policy ───────────────────────────────────────────────────────

  async evaluateToolCall(toolName: string, input: unknown): Promise<EvaluateToolCallResult | undefined> {
    const mode = this.currentMode();
    const catalogDefs = this.catalogDefinitions();
    const availableAgents = this.discoverAvailableAgents();
    const definition = this.currentDefinition();

    const bypassKey = makeBypassKey(toolName, input);
    if (this._oneShotBypasses.has(bypassKey)) {
      this._oneShotBypasses.delete(bypassKey);
      return { block: false };
    }

    const globalBashPatterns = this.globalBashPatterns();
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

    if (decision.ask) {
      if (!this.ctx) {
        return { block: true, reason: `Cannot confirm tool "${toolName}": UI not initialized` };
      }
      if (decision.warning) this.effects.notify(decision.warning, "warning");
      const message = decision.askMessage ?? `Allow tool "${toolName}" in ${mode.toUpperCase()} mode?`;
      const confirmed = await this.dialogs.confirm("Permission Request", message);
      if (!confirmed) {
        return { block: true, reason: `User denied tool: ${toolName}`, warning: decision.warning };
      }
      return { block: false, suggestedModes: decision.suggestedModes, warning: decision.warning };
    }

    if (decision.block && decision.suggestedModes && decision.suggestedModes.length > 0) {
      if (decision.warning) this.effects.notify(decision.warning, "warning");

      if (!this.ctx) {
        const suggestions = decision.suggestedModes.join(", ");
        return {
          block: true,
          reason: `${decision.reason}\n\nTo use this tool, switch to: ${suggestions}. Call request_mode_switch({ mode: "<mode>" }).`,
          warning: decision.warning,
        };
      }

      const suggestions = decision.suggestedModes.join(", ");
      const labels = [
        `Allow once — run "${toolName}" this time without switching mode`,
        `Switch mode — change to ${suggestions} (permanent until changed)`,
        "Deny — block this tool call",
      ];
      const choice = await this.dialogs.select("Tool blocked by mode policy", labels);

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
        this.effects.notify(`Allowed "${toolName}" once`, "info");
        return { block: false, warning: decision.warning };
      }

      if (choice.startsWith("Switch mode")) {
        const switchResult = this.setMode(decision.suggestedModes[0]);
        if (switchResult.ok) return { block: false, warning: decision.warning };
        return {
          block: true,
          reason: `Mode switch failed: ${switchResult.error}. ${decision.reason}`,
          warning: decision.warning,
        };
      }
    }

    if (decision.warning) this.effects.notify(decision.warning, "warning");
    return decision;
  }

  switchMode(targetMode: string): { ok: boolean; mode?: string; error?: string } {
    if (!this.catalog) return { ok: false, error: "Mode catalog not initialized" };
    if (!targetMode || typeof targetMode !== "string" || targetMode.length > MAX_MODE_NAME_LENGTH) {
      return { ok: false, error: "Invalid mode name" };
    }
    return this.setMode(targetMode);
  }

  // ── Commands / reload ────────────────────────────────────────────

  async handleCommand(
    args: string | undefined,
    selectMode: (options: ModeSelectOption[]) => Promise<string | undefined>,
  ): Promise<void> {
    if (!this.catalog) {
      this.effects.notify("Mode catalog not initialized", "error");
      return;
    }

    const command = args?.trim().toLowerCase();
    if (command === "reload") {
      await this.reload();
      return;
    }
    if (command === "status") {
      this.showStatus();
      return;
    }

    if (command) {
      const result = this.setMode(command);
      if (!result.ok) return;
      return;
    }

    const modes = this.modes();
    const options: ModeSelectOption[] = modes.map(m => ({
      name: m,
      description: this.definition(m)?.description,
    }));
    const selectedName = await selectMode(options);
    if (!selectedName) return;

    const mode = modes.find(m => m.toLowerCase() === selectedName) || PICKER_FALLBACK_MODE;
    this.setMode(mode);
  }

  async reload(): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const result = await loadAllModes();
    if (result.ok) {
      if (!this.catalog) {
        this.catalog = result.catalog;
        this._currentMode = this.catalog.definitions.has(this.defaultMode)
          ? this.defaultMode
          : this.firstAvailableMode();
      }
      notifyModeCatalogDiagnostics(ctx, result.diagnostics);
      this.acceptCatalog(result.catalog);
      this.updateStatus();
      return;
    }
    notifyModeCatalogDiagnostics(ctx, result.diagnostics);
    this.effects.notify(
      this.catalog ? "Mode reload failed; keeping previous known-good catalog" : "Mode reload failed; no known-good catalog loaded",
      this.catalog ? "warning" : "error",
    );
  }

  async checkAndReload(): Promise<void> {
    if (this.reloadPending || !this.catalog) return;
    this.reloadPending = true;
    try {
      const changed = await this.fileWatcher.hasChanges(this.catalog.loadedAt);
      if (changed) await this.reload();
    } catch (err) {
      console.error("[pi-agent-modes] Error checking for mode file changes:", err);
    } finally {
      this.reloadPending = false;
    }
  }

  // ── Hooks ────────────────────────────────────────────────────────

  buildPromptInjection(): string | undefined {
    const mode = this.currentMode();
    const promptSuffix = this.currentDefinition()?.prompt_suffix;
    const base = promptSuffix ? `\n\n[MODE: ${mode.toUpperCase()}]\n${promptSuffix}` : `\n\n[MODE: ${mode.toUpperCase()}]`;

    const definition = this.currentDefinition();
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
    if (!this._sessionId) {
      console.warn("[pi-agent-modes] turnEnd called without a sessionId; mode state not persisted");
      return;
    }
    this.persistMode();
  }

  // ── Editor ───────────────────────────────────────────────────────

  setupEditor(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const self: ModeStatusReader = this;
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

  // ── Private helpers ──────────────────────────────────────────────

  private applyModeChange(modeChanged: boolean, persist: boolean): void {
    this.effects.setActiveTools(this.activeTools());
    if (persist) this.persistMode();
    if (modeChanged) {
      this.effects.notify(`Mode: ${this._currentMode.toUpperCase()}`, "info");
      this.updateStatus();
    }
  }

  private pickRestoreMode(cliMode?: string, derivedMode?: string): string {
    if (!this.catalog) return this.defaultMode;
    const cli = normalizeMode(cliMode);
    if (cli && this.catalog.definitions.has(cli)) return cli;

    const derived = normalizeMode(derivedMode);
    if (derived && this.catalog.definitions.has(derived)) return derived;

    if (this.catalog.definitions.has(this._currentMode)) return this._currentMode;
    return this.safeFallbackMode();
  }

  private safeFallbackMode(): string {
    if (!this.catalog) return this.defaultMode;
    for (const mode of this.safeFallbackModes) {
      if (this.catalog.definitions.has(mode)) return mode;
    }
    return this.firstAvailableMode();
  }

  private firstAvailableMode(): string {
    return this.modes()[0] ?? this.defaultMode;
  }

  private persistMode(): void {
    this.effects.persistMode(this._currentMode, this._sessionId);
  }

  private updateStatus(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const mode = this.currentMode();
    const def = this.currentDefinition();
    const style = def?.border_style || "muted";

    let display = mode.toUpperCase();
    if (mode === "plan") display = "📋PLAN";
    else if (mode === "orchestrator") display = "🤝ORCH";
    else if (mode === "ask") display = "❓ASK";

    this.effects.setStatus("mode", ctx.ui.theme.fg(style, display));
  }

  private showStatus(): void {
    if (!this.ctx || !this.catalog) return;
    const mode = this.currentMode();
    const def = this.currentDefinition();
    const allTools = this.pi.getAllTools().map(t => t.name);
    const active = this.activeTools().length > 0 ? this.activeTools() : allTools;
    const suffixPreview = (def?.prompt_suffix || "").slice(0, SUFFIX_PREVIEW_LENGTH) + (def?.prompt_suffix && def.prompt_suffix.length > SUFFIX_PREVIEW_LENGTH ? "..." : "");

    const status = `Mode: ${mode}\nDescription: ${def?.description || "—"}\nActive tools (${active.length}): ${active.join(", ")}\nPrompt suffix: ${suffixPreview || "(none)"}\nBorder: ${def?.border_label || ""} (style: ${def?.border_style || "—"})`;
    this.effects.notify(status, "info");
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
    } catch (err) {
      console.debug("[pi-agent-modes] subagent bridge threw while discovering agents", err);
    }
    return [];
  }
}
