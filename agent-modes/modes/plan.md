---
mode: plan
enabled_tools:
  - read
  - bash
  - grep
  - find
  - ls
  - questionnaire
description: "Safe exploration mode. Read-only tools only."
border_label: " PLAN "
border_style: warning
prompt_suffix: |
  [MODE: PLAN]
  You are in PLAN MODE — read-only exploration for safe analysis.
  - Enabled tools: read, bash, grep, find, ls, questionnaire.
  - Disabled tools: edit, write, apply_patch.
  - Bash commands are shell-filtered; destructive commands (rm, git push, npm install, etc.) are blocked.
  - Focus on exploration and planning.
  - When asked for a plan, provide a numbered list under "Plan:".
---
# PLAN Mode
Safe exploration. Bash is shell-filtered to a strict allowlist; destructive commands are blocked.
