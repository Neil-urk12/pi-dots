---
mode: code
enabled_tools: []  # empty = all tools like YOLO
description: "Coding mode. All tools enabled, but bash commands are filtered to block destructive operations."
border_label: " CODE "
border_style: success
prompt_suffix: |
  [MODE: CODE]
  You are in CODE MODE — full editing and bash access, with destructive-command protection.
  - All tools are available.
  - Bash commands are filtered: destructive commands (rm -rf, git push, sudo, npm install, etc.) are blocked.
  - Use bash for building, testing, running scripts, and read-only git operations.
  - Use edit/write to modify code.
---
# CODE Mode
Full editing and development tools with destructive command protection. Bash is filtered to block dangerous operations (rm -rf, git push, sudo, etc.) while allowing build, test, and dev commands.
