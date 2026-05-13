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

  restore(input: ModeRestoreInput): ModeRuntimeEffects {
    const nextMode = this.pickRestoreMode(input.cliMode, input.sessionMode);
    const modeChanged = nextMode !== this.currentMode;
    this.currentMode = nextMode;
    return this.effects(modeChanged, false);
  }

  setMode(mode: Mode): SetModeResult {
    if (!this.catalog.definitions.has(mode)) {
      return {
        ok: false,
        error: `Invalid mode: ${mode}. Available: ${this.modes().join(", ")}`,
      };
    }

    const modeChanged = mode !== this.currentMode;
    this.currentMode = mode;
    return {
      ok: true,
      mode,
      effects: this.effects(modeChanged, modeChanged),
    };
  }

  cycleMode(): ModeRuntimeEffects {
    const modes = this.modes();
    const curIndex = modes.indexOf(this.currentMode);
    const next = modes[(curIndex + 1) % modes.length] ?? this.firstAvailableMode();
    const modeChanged = next !== this.currentMode;
    this.currentMode = next;
    return this.effects(modeChanged, modeChanged);
  }

  acceptCatalog(catalog: ModeCatalog): ReloadCatalogResult {
    this.catalog = catalog;
    let fallbackMode: Mode | undefined;
    let modeChanged = false;

    if (!this.catalog.definitions.has(this.currentMode)) {
      fallbackMode = this.safeFallbackMode();
      modeChanged = fallbackMode !== this.currentMode;
      this.currentMode = fallbackMode;
    }

    return {
      accepted: true,
      modeChanged,
      fallbackMode,
      effects: this.effects(modeChanged, modeChanged),
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

  private effects(modeChanged: boolean, persist: boolean): ModeRuntimeEffects {
    return {
      modeChanged,
      persist,
      activeTools: this.activeTools(),
    };
  }
}

function normalizeMode(mode?: string): string | undefined {
  const normalized = mode?.trim().toLowerCase();
  return normalized || undefined;
}
