import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Mode, type ModeSelectOption } from "./mode.js";
export { Mode, type ModeEffects, type ModeDialogs, type ModeStatusReader, type ModeSelectOption, type EvaluateToolCallResult } from "./mode.js";
export { buildModeCatalog, loadAllModes } from "./mode-catalog.js";
export { ModeFileWatcher } from "./mode-file-watcher.js";
export { evaluateToolCall, findModesForTool, resolveBashPatterns, validateBashPattern } from "./mode-tool-policy.js";
export { injectIntoPayload } from "./payload-injection.js";
export { DEFAULT_MODE, SAFE_FALLBACK_MODES, PICKER_FALLBACK_MODE, MAX_MODE_NAME_LENGTH, SUFFIX_PREVIEW_LENGTH, USER_CONFIG_DIR, USER_CONFIG_FILE, errorMessage, errorCode } from "./types.js";
import { ModeFileWatcher } from "./mode-file-watcher.js";
import { USER_CONFIG_DIR, USER_CONFIG_FILE } from "./types.js";

export default async function (pi: ExtensionAPI) {
  const baseDir = path.dirname(fileURLToPath(import.meta.url));
  const fileWatcher = new ModeFileWatcher(
    path.join(baseDir, "..", "modes"),
    path.join(os.homedir(), USER_CONFIG_DIR, USER_CONFIG_FILE),
  );
  const mode = new Mode(pi, fileWatcher);

  // CLI flag: --mode <mode>
  pi.registerFlag("mode", {
    description: "Start in tool mode (e.g. yolo, plan, code, ask, orchestrator)",
    type: "string",
  });

  async function handleModeCommand(args: string | undefined, ctx: ExtensionContext): Promise<void> {
    await mode.handleCommand(args, async (options: ModeSelectOption[]) => {
      const labels = options.map(o => o.description ? `${o.name.toUpperCase()} — ${o.description}` : o.name.toUpperCase());
      const choice = await ctx.ui.select("Select mode:", labels);
      if (!choice) return undefined;
      return choice.split(" — ")[0].toLowerCase();
    });
  }

  pi.registerCommand("patterns", {
    description: "Show active bash patterns and their effective severities",
    handler: async (args, ctx) => {
      const targetMode = args?.trim().toLowerCase() || mode.currentMode();
      const def = mode.definition(targetMode);
      if (!def) {
        ctx.ui.notify(`Unknown mode: ${targetMode}`, "error");
        return;
      }
      const globalPatterns = mode.globalBashPatterns();
      const modePatterns = def.bash_patterns;
      const { renderPatternsDialog } = await import("./mode-patterns.js");
      const { resolveBashPatterns } = await import("./mode-tool-policy.js");
      const resolved = resolveBashPatterns(globalPatterns, modePatterns);
      const options = renderPatternsDialog({
        mode: targetMode,
        definition: def,
        bashPatterns: resolved,
        globalBashPatterns: globalPatterns,
      });
      if (options.length === 0) {
        ctx.ui.notify(`No bash patterns for mode: ${targetMode}`, "warning");
        return;
      }
      await ctx.ui.select("Bash patterns", options);
    },
  });

  pi.registerCommand("mode", {
    description: "Switch tool mode (yolo, plan, code, ask, orchestrator)",
    handler: async (args, ctx) => handleModeCommand(args, ctx),
  });

  pi.registerCommand("modes", {
    description: "Alias for /mode",
    handler: async (args, ctx) => handleModeCommand(args, ctx),
  });

  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Cycle modes (yolo → plan → code → ask → orchestrator)",
    handler: async () => { mode.cycleMode(); },
  });

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
      const currentDef = mode.currentDefinition();
      const skipConfirm = currentDef?.auto_mode_switch === true;

      if (!skipConfirm) {
        const currentMode = mode.currentMode();
        const confirmed = await ctx.ui.confirm(
          "Mode Switch",
          `Agent wants to switch from ${currentMode.toUpperCase()} to ${params.mode.toUpperCase()} mode. Allow?`,
        );
        if (!confirmed) {
          return {
            content: [{ type: "text" as const, text: `User denied mode switch to ${params.mode}.` }],
            details: undefined,
            isError: true,
          };
        }
      }

      const result = mode.switchMode(params.mode);
      if (result.ok) {
        return { content: [{ type: "text" as const, text: `Switched to ${result.mode} mode. You can now retry your previous tool call.` }], details: undefined };
      }
      return { content: [{ type: "text" as const, text: `Failed to switch mode: ${result.error}` }], details: undefined, isError: true };
    },
  });

  pi.on("before_provider_request", async (event) => {
    return mode.beforeProviderRequest(event.payload);
  });

  pi.on("tool_call", async (event) => {
    return mode.evaluateToolCall(event.toolName, event.input);
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = crypto.randomUUID();
    await mode.initialize(ctx, sessionId);
    mode.captureBaselineTools(pi.getAllTools().map(t => t.name));

    const allToolNames = pi.getAllTools().map(t => t.name);
    const isSubagent = process.env.PI_IS_SUBAGENT === "1" || !allToolNames.includes("Agent");
    const subagentMode = isSubagent
      ? (allToolNames.includes("write") || allToolNames.includes("edit") ? "code" : "plan")
      : undefined;

    const flag = pi.getFlag("mode");
    mode.restore(typeof flag === "string" ? flag : undefined, mode.restoreFromSession(sessionId) ?? subagentMode);
    mode.setupEditor();
  });

  pi.on("turn_end", async () => {
    mode.turnEnd();
    await mode.checkAndReload();
  });
}
