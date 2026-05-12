import type { ModeDefinition } from "./types.js";

const MODE_PROMPTS = {
  yolo: "",
  plan: `
You are in PLAN MODE — a read-only exploration mode for safe code analysis.

RESTRICTIONS:
- Allowed tools: read, bash, grep, find, ls, questionnaire
- Forbidden tools: edit, write (cannot modify files)
- Bash commands are restricted to an allowlist of read-only commands; destructive commands are automatically blocked.

ACTIONS:
- Explore the codebase deeply using the allowed tools.
- Ask clarifying questions using the questionnaire tool.
- When asked, create a detailed, numbered plan under a "Plan:" header:

Plan:
1. First step
2. Second step
...

DO NOT attempt to make any file changes. Only describe what you would do.
`,
  orchestrator: `
You are in ORCHESTRATOR MODE — act as a coordinator of work.

PRINCIPLES:
- Break complex tasks into subtasks.
- Delegate subtasks using the 'subagent' tool to specialized agents (e.g., coder, reviewer, tester).
- For simple changes that you can do directly, perform them yourself.
- Track progress and synthesize results from subagents.
- Plan first, then orchestrate execution using subagents where beneficial.
`,
  code: `
[MODE: CODE]
You are in CODE MODE — full editing and bash access, with destructive-command protection.
- All tools are available.
- Bash commands are filtered: destructive commands (rm -rf, git push, sudo, npm install, etc.) are blocked.
- Use bash for building, testing, running scripts, and read-only git operations.
- Use edit/write to modify code.
`,
  ask: `
[MODE: ASK]
You are in ASK MODE — clarification-first requirement gathering.
- Enabled tools: read, bash, grep, find, ls, questionnaire.
- Disabled tools: edit, write, apply_patch.
- Bash is shell-filtered; destructive commands (rm -rf, git push, etc.) are blocked.
- Your ONLY job: ask structured questions to clarify the user's request.
- Gather full requirements, constraints, and context before any implementation.
- Present a numbered list of requirements or acceptance criteria once gathered.
- If the user already provides a clear spec, confirm understanding by summarizing back.
- DO NOT make file changes. DO NOT attempt implementation.
`,
} as const;

const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"] as const;

export function getLegacyConfig(mode: string): ModeDefinition | null {
  if (mode === "plan") {
    return {
      mode: "plan",
      enabled_tools: Array.from(PLAN_TOOLS),
      prompt_suffix: MODE_PROMPTS.plan.trim(),
      description: "Safe exploration mode. Read-only tools only.",
      border_label: " PLAN ",
      border_style: "warning",
    };
  }
  if (mode === "code") {
    return {
      mode: "code",
      enabled_tools: [], // all tools, like yolo
      prompt_suffix: MODE_PROMPTS.code.trim(),
      description: "Coding mode. All tools enabled, but bash commands are filtered to block destructive operations.",
      border_label: " CODE ",
      border_style: "success",
    };
  }
  
  if (mode === "orchestrator") {
    return {
      mode: "orchestrator",
      enabled_tools: [], // all tools
      prompt_suffix: MODE_PROMPTS.orchestrator.trim(),
      description: "Coordination mode. Delegates tasks to subagents.",
      border_label: " ORCH ",
      border_style: "accent",
    };
  }
  if (mode === "yolo") {
    return {
      mode: "yolo",
      enabled_tools: [], // all tools
      prompt_suffix: MODE_PROMPTS.yolo, // empty string
      description: "Full unrestricted access. All tools available.",
      border_label: " YOLO ",
      border_style: "success",
    };
  }
  if (mode === "ask") {
    return {
      mode: "ask",
      enabled_tools: Array.from(["read", "bash", "grep", "find", "ls", "questionnaire"] as const),
      prompt_suffix: MODE_PROMPTS.ask.trim(),
      description: "Clarification-first mode. Gather requirements before acting.",
      border_label: " ASK ",
      border_style: "muted",
    };
  }
  return null;
}

export const MODE_ORDER = ["yolo", "plan", "code", "ask", "orchestrator"] as const;
