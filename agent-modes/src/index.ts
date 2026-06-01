import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ModeSessionCoordinator, lastSessionMode, type ModeSelectOption } from "./mode-session-coordinator.js";
export { buildModeCatalog, loadAllModes } from "./mode-catalog.js";
export { ModeFileWatcher } from "./mode-file-watcher.js";
export { ModeRuntimeController } from "./mode-runtime.js";
export { ModeSessionCoordinator, lastSessionMode } from "./mode-session-coordinator.js";
export { evaluateToolCall, findModesForTool, resolveBashPatterns, validateBashPattern } from "./mode-tool-policy.js";
export { injectIntoPayload } from "./payload-injection.js";
export { DEFAULT_MODE, SAFE_FALLBACK_MODES, PICKER_FALLBACK_MODE, MAX_MODE_NAME_LENGTH, SUFFIX_PREVIEW_LENGTH, USER_CONFIG_DIR, USER_CONFIG_FILE, errorMessage, errorCode } from "./types.js";

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
    async execute(_toolCallId: string, params: { mode: string }, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
      // Check if current mode allows auto-switching without confirmation
      const currentDef = coordinator.currentDefinition();
      const skipConfirm = currentDef?.auto_mode_switch === true;
      
      if (!skipConfirm) {
        const currentMode = coordinator.currentMode();
        const confirmed = await ctx.ui.confirm(
          "Mode Switch",
          `Agent wants to switch from ${currentMode.toUpperCase()} to ${params.mode.toUpperCase()} mode. Allow?`
        );
        if (!confirmed) {
          return {
            content: [{ type: "text" as const, text: `User denied mode switch to ${params.mode}.` }],
            details: undefined,
            isError: true,
          };
        }
      }
      
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
    const sessionId = crypto.randomUUID();
    await coordinator.initialize(ctx, sessionId);
    coordinator.captureBaselineTools();

    // Detect subagent session using environment variable (primary) or tool-based detection (fallback)
    const allToolNames = pi.getAllTools().map(t => t.name);
    const isSubagent = process.env.PI_IS_SUBAGENT === "1" || !allToolNames.includes("Agent");
    const subagentMode = isSubagent
      ? (allToolNames.includes("write") || allToolNames.includes("edit") ? "code" : "plan")
      : undefined;

    const flag = pi.getFlag("mode");
    coordinator.restoreMode(typeof flag === "string" ? flag : undefined, lastSessionMode(ctx, sessionId) ?? subagentMode);
    coordinator.setupEditor();
  });

  // Persist after each turn, auto-reload if files changed
  pi.on("turn_end", async (_event, ctx) => {
    coordinator.turnEnd();
    await coordinator.checkAndReload();
  });
}
