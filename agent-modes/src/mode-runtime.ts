import type { ModeCatalog } from "./mode-catalog.js";
import type { ModeDefinition } from "./types.js";

export type Mode = string;

export interface ModeRuntimeControllerOptions {
  defaultMode?: Mode;
  safeFallbackModes?: readonly Mode[];
}

export interface ModeRuntimeSnapshot {
  currentMode: Mode;
  modes: Mode[];
  loadedAt: number;
}

export interface ModeRuntimeEffects {
  modeChanged: boolean;
  persist: boolean;
  activeTools: string[];
}

export interface ModeRestoreInput {
  cliMode?: string;
  sessionMode?: string;
}

export interface SetModeResult {
  ok: boolean;
  mode?: Mode;
  effects?: ModeRuntimeEffects;
  error?: string;
}

export interface ReloadCatalogResult {
  accepted: boolean;
  modeChanged: boolean;
  fallbackMode?: Mode;
  effects?: ModeRuntimeEffects;
}

export type ModeRuntimeEventType =
  | "session_start"
  | "mode_select"
  | "mode_cycle"
  | "mode_reload_result"
  | "tool_call"
  | "turn_end";

export interface ModeRuntimeTransitionInput {
  type: ModeRuntimeEventType;
  cliMode?: string;
  sessionMode?: string;
  requestedMode?: string;
  catalog?: ModeCatalog;
  toolName?: string;
}

export interface ModeRuntimeStatus {
  mode: Mode;
  borderStyle: NonNullable<ModeDefinition["border_style"]>;
}

export interface ModeRuntimeNotification {
  level: "info" | "warning" | "error";
  message: string;
}

export interface ModeRuntimeDecision {
  nextState: ModeRuntimeSnapshot;
  modeChanged: boolean;
  activeTools: string[];
  status: ModeRuntimeStatus;
  persistModeState: boolean;
  notifications: ModeRuntimeNotification[];
  toolCallVerdict?: {
    allow: boolean;
    reason?: string;
  };
  acceptedCatalog?: boolean;
  fallbackMode?: Mode;
  error?: string;
}

export class ModeRuntimeController {
  private catalog: ModeCatalog;
  private currentMode: Mode;
  private baselineTools: string[] = [];
  private readonly defaultMode: Mode;
  private readonly safeFallbackModes: readonly Mode[];

  constructor(catalog: ModeCatalog, options: ModeRuntimeControllerOptions = {}) {
    this.catalog = catalog;
    this.defaultMode = options.defaultMode ?? "yolo";
    this.safeFallbackModes = options.safeFallbackModes ?? ["plan", "ask", "yolo"];
    this.currentMode = this.catalog.definitions.has(this.defaultMode)
      ? this.defaultMode
      : this.firstAvailableMode();
  }

  snapshot(): ModeRuntimeSnapshot {
    return {
      currentMode: this.currentMode,
      modes: this.modes(),
      loadedAt: this.catalog.loadedAt,
    };
  }

  modes(): Mode[] {
    return Array.from(this.catalog.definitions.keys());
  }

  definition(mode: Mode = this.currentMode): ModeDefinition | undefined {
    return this.catalog.definitions.get(mode);
  }

  lastLoadTime(): number {
    return this.catalog.loadedAt;
  }

  captureBaselineTools(toolNames: string[]): void {
    if (this.baselineTools.length === 0) {
      this.baselineTools = [...toolNames];
    }
  }

  transition(input: ModeRuntimeTransitionInput): ModeRuntimeDecision {
    switch (input.type) {
      case "session_start": {
        const nextMode = this.pickRestoreMode(input.cliMode, input.sessionMode);
        const modeChanged = nextMode !== this.currentMode;
        this.currentMode = nextMode;
        return this.decision({ modeChanged, persistModeState: false });
      }

      case "mode_select": {
        const requestedMode = normalizeMode(input.requestedMode);
        if (!requestedMode || !this.catalog.definitions.has(requestedMode)) {
          return this.decision({
            modeChanged: false,
            persistModeState: false,
            error: `Invalid mode: ${input.requestedMode}. Available: ${this.modes().join(", ")}`,
            notifications: [{
              level: "error",
              message: `Invalid mode: ${input.requestedMode}. Available: ${this.modes().join(", ")}`,
            }],
          });
        }

        const modeChanged = requestedMode !== this.currentMode;
        this.currentMode = requestedMode;
        return this.decision({ modeChanged, persistModeState: modeChanged });
      }

      case "mode_cycle": {
        const modes = this.modes();
        const curIndex = modes.indexOf(this.currentMode);
        const next = modes[(curIndex + 1) % modes.length] ?? this.firstAvailableMode();
        const modeChanged = next !== this.currentMode;
        this.currentMode = next;
        return this.decision({ modeChanged, persistModeState: modeChanged });
      }

      case "mode_reload_result": {
        if (!input.catalog) {
          return this.decision({ acceptedCatalog: false });
        }

        this.catalog = input.catalog;
        let fallbackMode: Mode | undefined;
        let modeChanged = false;
        const notifications: ModeRuntimeNotification[] = [];

        if (!this.catalog.definitions.has(this.currentMode)) {
          fallbackMode = this.safeFallbackMode();
          modeChanged = fallbackMode !== this.currentMode;
          this.currentMode = fallbackMode;
        }

        if (fallbackMode) {
          notifications.push({
            level: "warning",
            message: `Mode definitions reloaded; current mode missing, fell back to ${fallbackMode.toUpperCase()}`,
          });
        } else {
          notifications.push({ level: "info", message: "Mode definitions reloaded" });
        }

        return this.decision({
          acceptedCatalog: true,
          modeChanged,
          fallbackMode,
          persistModeState: modeChanged,
          notifications,
        });
      }

      case "tool_call":
        return this.decision({
          toolCallVerdict: { allow: true },
          persistModeState: false,
          modeChanged: false,
        });

      case "turn_end":
        return this.decision({ modeChanged: false, persistModeState: true });
    }
  }

  restore(input: ModeRestoreInput): ModeRuntimeEffects {
    return this.effectsFromDecision(this.transition({
      type: "session_start",
      cliMode: input.cliMode,
      sessionMode: input.sessionMode,
    }));
  }

  setMode(mode: Mode): SetModeResult {
    const decision = this.transition({ type: "mode_select", requestedMode: mode });
    if (decision.error) {
      return { ok: false, error: decision.error };
    }

    return {
      ok: true,
      mode: this.currentMode,
      effects: this.effectsFromDecision(decision),
    };
  }

  cycleMode(): ModeRuntimeEffects {
    const decision = this.transition({ type: "mode_cycle" });
    return this.effectsFromDecision(decision);
  }

  acceptCatalog(catalog: ModeCatalog): ReloadCatalogResult {
    const decision = this.transition({ type: "mode_reload_result", catalog });
    return {
      accepted: decision.acceptedCatalog ?? true,
      modeChanged: decision.modeChanged,
      fallbackMode: decision.fallbackMode,
      effects: this.effectsFromDecision(decision),
    };
  }

  keepCatalog(): ReloadCatalogResult {
    return { accepted: false, modeChanged: false };
  }

  currentPromptSuffix(): string | undefined {
    return this.definition()?.prompt_suffix;
  }

  activeTools(): string[] {
    const enabled = this.definition()?.enabled_tools;
    return enabled && enabled.length > 0 ? [...enabled] : [...this.baselineTools];
  }

  private pickRestoreMode(cliMode?: string, sessionMode?: string): Mode {
    const cli = normalizeMode(cliMode);
    if (cli && this.catalog.definitions.has(cli)) return cli;

    const session = normalizeMode(sessionMode);
    if (session && this.catalog.definitions.has(session)) return session;

    if (this.catalog.definitions.has(this.currentMode)) return this.currentMode;
    return this.safeFallbackMode();
  }

  private safeFallbackMode(): Mode {
    for (const mode of this.safeFallbackModes) {
      if (this.catalog.definitions.has(mode)) return mode;
    }
    return this.firstAvailableMode();
  }

  private firstAvailableMode(): Mode {
    return this.modes()[0] ?? this.defaultMode;
  }

  private effectsFromDecision(decision: ModeRuntimeDecision): ModeRuntimeEffects {
    return {
      modeChanged: decision.modeChanged,
      persist: decision.persistModeState,
      activeTools: decision.activeTools,
    };
  }

  private decision({
    modeChanged = false,
    persistModeState = false,
    notifications = [],
    toolCallVerdict,
    acceptedCatalog,
    fallbackMode,
    error,
  }: {
    modeChanged?: boolean;
    persistModeState?: boolean;
    notifications?: ModeRuntimeNotification[];
    toolCallVerdict?: { allow: boolean; reason?: string };
    acceptedCatalog?: boolean;
    fallbackMode?: Mode;
    error?: string;
  }): ModeRuntimeDecision {
    const status: ModeRuntimeStatus = {
      mode: this.currentMode,
      borderStyle: this.definition()?.border_style ?? "muted",
    };

    return {
      nextState: this.snapshot(),
      modeChanged,
      activeTools: this.activeTools(),
      status,
      persistModeState,
      notifications,
      toolCallVerdict,
      acceptedCatalog,
      fallbackMode,
      error,
    };
  }
}

function normalizeMode(mode?: string): string | undefined {
  const normalized = mode?.trim().toLowerCase();
  return normalized || undefined;
}
