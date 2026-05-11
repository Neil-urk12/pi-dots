---
mode: orchestrator
enabled_tools: []  # empty = all tools
description: "Coordination mode. Delegates tasks to subagents."
border_label: " ORCH "
border_style: accent
prompt_suffix: |
  [MODE: ORCHESTRATOR]
  You are in orchestrator mode. Your workflow:
  1. Break the user's request into independent subtasks
  2. For each subtask, use the `subagent` tool to delegate
  3. Collect results and synthesize into final answer
  4. Track progress; if a subagent fails, retry or re-plan
  Delegate early and often.
---
# ORCHESTRATOR Mode
Break tasks into subtasks. Delegate using the `subagent` tool. Track progress. Synthesize results.
