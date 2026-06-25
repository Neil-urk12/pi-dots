# Changelog

All notable changes to this project will be documented in this file.

## [0.4.0] - 2026-06-26

### Added
- **Smart bash allow with prefix matching**: When a bash command is blocked by mode policy, users can now choose "Allow once (prefix)" or "Allow for session (prefix)" to allow commands starting with the same prefix. For example, allowing `npm install` will also permit `npm install --save-dev`. Case-sensitive, whitespace-trimmed.
- **Session-level tool bypass**: When a tool call is blocked by mode policy, users can now choose "Allow for rest of session" to permit the tool for all subsequent calls without switching modes. Unlike "Allow once" which is consumed after one use, session grants persist until the session ends or `clear()` is called.

## [0.2.0] - 2026-06-02

### Added
- **One-shot bypass mechanism**: When a tool call is blocked by mode policy, users can now choose "Allow once" to permit a single use without switching modes. The bypass is automatically consumed after one retry.
- **Bypass key uniqueness**: Replaced 32-bit DJB2 hash with full JSON string for bypass key generation, eliminating hash collision risk.
- **Bypass size cap**: Added `MAX_BYPASS_SIZE = 100` with insertion-order eviction to prevent unbounded memory growth.
- **Bypass session isolation**: `_oneShotBypasses` Set is cleared on `initialize()` to prevent bypass entries from leaking across sessions.
- **JSON.stringify safety**: `makeBypassKey` now wraps `JSON.stringify` in try-catch with `"<unserializable>"` fallback for circular references.
- **Session-scoped mode state**: Mode selection now persists per session using a UUID session ID. `lastSessionMode()` filters by session ID with backward-compatible fallback.
- **Mode switch confirmation**: `request_mode_switch` tool now shows a confirmation dialog before switching modes, unless the current mode has `auto_mode_switch: true`.
- **Subagent detection**: Added `PI_IS_SUBAGENT` environment variable as primary detection method, with tool-based detection (`Agent` tool missing) as fallback.
- **New exports**: `DEFAULT_MODE`, `SAFE_FALLBACK_MODES`, `PICKER_FALLBACK_MODE`, `MAX_MODE_NAME_LENGTH`, `SUFFIX_PREVIEW_LENGTH`, `USER_CONFIG_DIR`, `USER_CONFIG_FILE`, `errorMessage`, `errorCode` are now exported from `index.ts`.

### Changed
- **Orchestrator agent names**: Renamed agents from `Explore/scout/worker/planner/reviewer/general-purpose` to `blitz` (fast codebase recon), `grind` (general-purpose code agent), `seeker` (web research agent).
- **`initialize()` signature**: Now accepts optional `sessionId?: string` parameter.
- **`lastSessionMode()` signature**: Now accepts optional `sessionId?: string` parameter.
- **`ModeDefinition` type**: Added `auto_mode_switch?: boolean` field.

### Fixed
- **Hash collision in bypass keys**: DJB2 32-bit hash could produce identical keys for different inputs, causing bypass to leak across distinct tool calls. Fixed by using full JSON string as key.
- **Unbounded bypass growth**: `_oneShotBypasses` Set had no size cap, allowing unlimited memory growth. Fixed with 100-entry cap and insertion-order eviction.
- **Cross-session bypass leakage**: Bypass entries from previous sessions could persist into new sessions. Fixed by clearing Set on `initialize()`.
- **Circular reference crash**: `JSON.stringify` could throw on circular references in tool inputs. Fixed with try-catch and fallback.

### Tests
- Added `bypass-key-uniqueness.test.mjs` (237 lines): Tests for bypass key uniqueness, consumption behavior, size cap, circular reference handling, null/undefined input, and session isolation.
- Added `mode-switch-confirmation.test.mjs` (194 lines): Tests for mode switch confirmation dialog and `auto_mode_switch` flag.
- Added `session-scoped-coordinator.test.mjs` (160 lines): Tests for session ID tracking and session-scoped mode state.
- Added `subagent-detection.test.mjs` (120 lines): Tests for `PI_IS_SUBAGENT` env var and tool-based fallback detection.

## [0.1.3] - 2026-06-02

### Added
- **Permissions system**: Mode-level permissions for fine-grained tool access control.
- **Bash pattern customization**: `bash_patterns` field in mode definitions for custom command patterns.
- **Allowed agents enforcement**: `allowed_agents` field enforced in mode tool policy.
- **Mode suggestions**: When tool calls are blocked, suggest alternative modes that allow the tool.
- **Public API improvements**: Better error handling and public API surface.

### Changed
- **Type safety**: Improved TypeScript types throughout the codebase.
- **Tighter defaults**: Stricter default policies for restricted modes.
- **Tool API migration**: Migrated to new tool API interface.

### Fixed
- **Curl in strict_readonly**: Blocked curl file-writing flags in strict_readonly bash policy.
- **YAML deserialization**: Added security tests for YAML deserialization.
- **Permission error logging**: Improved error logging for permission violations.

### Refactored
- Extract `ModeSessionCoordinator` from `index.ts`.
- Made orchestrator mode the default.

## [0.1.2] - 2026-06-02

### Changed
- **Build system**: Switched from `tsc` to `tsup` for building.
- **Test framework**: Switched from `node:test` to `vitest` for testing.
- **Default mode**: Made orchestrator mode the default.

### Refactored
- Extract `ModeFileWatcher` class from file-watcher logic.
- Extract `ModeSessionCoordinator` from `index.ts`.

## [0.1.1] - 2026-06-02

### Added
- **Dynamic mode discovery**: Modes discovered and loaded from markdown files.
- **Mode-specific bash patterns**: Each mode can define its own bash patterns.

### Changed
- **Package metadata**: Updated package name and repository field.

### Fixed
- **Curl file-writing flags**: Blocked curl file-writing flags in destructive-policy modes.
- **Import.meta.url resolution**: Use `fileURLToPath` for proper ESM path resolution.

### Refactored
- Extract `ModeRuntimeController` class for testability.
- Extract mode prompt injection into helper module.
- Split `injectIntoPayload` into testable module.
- Extract bash policy engine into module with mode-level patterns.
- Unify `ModeRuntimeController` state machine via `transition()`.
- Extract pure `buildModeCatalog` from I/O-coupled loader.

## [0.1.0] - 2026-06-02

### Added
- **Initial release**: Multi-mode extension for the pi coding agent.
- **Modes**: YOLO, PLAN, CODE, ASK, ORCHESTRATOR.
- **Markdown-driven config**: Mode definitions stored in markdown files with YAML frontmatter.
- **Dynamic loading**: Modes loaded dynamically from markdown files.
- **Mode picker**: Interactive mode selection via `/mode` command.
- **CLI flag**: `--mode` flag for starting in a specific mode.
- **Keyboard shortcut**: `Ctrl+Shift+M` to cycle modes.
- **Dynamic reload**: `/mode reload` to reload mode definitions.
- **User overrides**: `~/.pi/modes/config.yaml` for user-specific overrides.
- **Mode prompt injection**: Mode-specific prompts injected into provider requests.
- **Tool policy enforcement**: Tool access controlled by mode policy.
