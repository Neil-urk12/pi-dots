import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeEffects } from "./mode.js";

/** Production adapter: routes side effects to the pi extension API and TUI. */
export class PiModeEffects implements ModeEffects {
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
  ) {}

  setActiveTools(tools: string[]): void {
    this.pi.setActiveTools(tools);
  }

  persistMode(mode: string, sessionId?: string): void {
    this.pi.appendEntry("mode-state", { mode, sessionId });
  }

  notify(message: string, level: "info" | "warning" | "error"): void {
    this.ctx.ui.notify(message, level);
  }

  setStatus(key: string, display: string): void {
    this.ctx.ui.setStatus(key, display);
  }
}
