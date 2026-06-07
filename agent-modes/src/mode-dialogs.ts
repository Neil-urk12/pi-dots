import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModeDialogs } from "./mode.js";

/** Production adapter: routes interactive queries to the TUI. */
export class PiModeDialogs implements ModeDialogs {
  constructor(private readonly ctx: ExtensionContext) {}

  async confirm(title: string, message: string): Promise<boolean> {
    return this.ctx.ui.confirm(title, message);
  }

  async select(prompt: string, options: string[]): Promise<string | undefined> {
    return this.ctx.ui.select(prompt, options);
  }
}
