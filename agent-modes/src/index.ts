import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModeSessionCoordinator, lastSessionMode, type ModeSelectOption } from "./mode-session-coordinator.js";
export { buildModeCatalog, loadAllModes } from "./mode-catalog.js";
export { ModeFileWatcher } from "./mode-file-watcher.js";
export { ModeRuntimeController } from "./mode-runtime.js";
export { ModeSessionCoordinator, lastSessionMode } from "./mode-session-coordinator.js";
export { evaluateToolCall, findModesForTool } from "./mode-tool-policy.js";
export { injectIntoPayload } from "./payload-injection.js";

export default async function (pi: ExtensionAPI) {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const coordinator = new ModeSessionCoordinator(pi, baseDir);

  // CLI flag: --mode <mode>
  pi.registerFlag("mode", {
    description: "Start in tool mode (e.g. yolo, plan, code, ask, orchestrator)",
    type: "string",
  });

  // Commands
  async function handleModeCommand(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    await coordinator.handleCommand(args, async (options: ModeSelectOption[]) => {
      const labels = options.map(o => o.description ? `${o.name.toUpperCase()} — ${o.description}` : o.name.toUpperCase());
      const choice = await ctx.ui.select("Select mode:", labels);
      if (!choice) return undefined;
      return choice.split(" — ")[0].toLowerCase();
    });
  }

  pi.registerCommand("mode", {
    description: "Switch tool mode (yolo, plan, code, ask, orchestrator)",
    handler: async (args, ctx) => handleModeCommand(args, ctx),
  });

  pi.registerCommand("modes", {
    description: "Alias for /mode",
    handler: async (args, ctx) => handleModeCommand(args, ctx),
  });

  // Shortcut: cycle mode
  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Cycle modes (yolo → plan → code → ask → orchestrator)",
    handler: async () => { coordinator.cycleMode(); },
  });

  // Tool: request_mode_switch — allows agent to switch modes when blocked
  pi.registerTool({
    name: "request_mode_switch",
    label: "Switch Mode",
    description: "Switch to a different agent mode. Use this when a tool call is blocked and the error message suggests switching modes.",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description: "The mode to switch to (e.g. code, yolo, plan, ask, orchestrator)",
        },
      },
      required: ["mode"],
    },
    async execute(_toolCallId: string, params: { mode: string }) {
      const result = coordinator.switchMode(params.mode);
      if (result.ok) {
        return { content: [{ type: "text" as const, text: `Switched to ${result.mode} mode. You can now retry your previous tool call.` }], details: undefined };
      }
      return { content: [{ type: "text" as const, text: `Failed to switch mode: ${result.error}` }], details: undefined, isError: true };
    },
  });

  // Inject mode prompt on every provider request
  pi.on("before_provider_request", async (event) => {
    return coordinator.beforeProviderRequest(event.payload);
  });

  // Gate tool access based on mode policy
  pi.on("tool_call", async (event) => {
    return coordinator.evaluateToolCall(event.toolName, event.input);
  });

  // Initialize on session start or resume
  pi.on("session_start", async (_event, ctx) => {
    await coordinator.initialize(ctx);
    coordinator.captureBaselineTools();
    const flag = pi.getFlag("mode");
    coordinator.restoreMode(typeof flag === "string" ? flag : undefined, lastSessionMode(ctx));
    coordinator.setupEditor();
  });

  // Persist after each turn, auto-reload if files changed
  pi.on("turn_end", async (_event, ctx) => {
    coordinator.turnEnd();
    await coordinator.checkAndReload();
  });
}
