# AGENTS.md — pi-clean-footer

A powerline-style footer extension for [pi](https://pi.dev) coding agent. Published as `@neilurk12/pi-clean-footer`.

## Essential commands

| Command | Action |
|---|---|
| `pnpm build` | Build with tsup (ESM only, minified, to `dist/`) |
| `pnpm dev` | Watch mode (`tsup --watch`) |
| `pnpm test` | `vitest run` — **always run before committing** |
| `pnpm test:watch` | `vitest` (interactive watch) |
| `pnpm lint:check` | `oxlint .` (default correctness rules) |
| `pnpm lint:fix` | `oxlint --fix .` |
| `pnpm format` | `oxfmt --write` on `src/**/*.ts` |
| `pnpm format:check` | `oxfmt --check` on `src/**/*.ts` |

> **Note**: The script is named `lint:check` (not `lint`) because pnpm v11 has a built-in handler for the literal script name `lint` that fails with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "eslint" not found` regardless of the actual command. Workaround: use `pnpm exec oxlint .` directly, or run `pnpm run lint:check`.

Build output is `dist/index.js` only (single entry, no declarations, no sourcemaps).

## Project structure

```
src/
├── index.ts           # Entry point — registers commands and events via ExtensionAPI
├── eventAdapter.ts     # createEventAdapter factory — wires events → state
├── config.ts          # File I/O for JSON config loading (re-exports configSchema)
├── configSchema.ts    # Config types, defaults, presets, validation, resolution
├── renderer.ts        # Renders FooterInput → string[] using layout engine
├── layout.ts          # Left/right split layout with truncation
├── modelName.ts       # Smart model ID shortening
├── tokenFormat.ts     # Token string formatters (full, no-cache, total-only)
├── tokens.ts          # Accumulate token totals and cost from session entries
├── toksActivity.ts    # Tok/s rate estimator and activity animation (factory)
├── git.ts             # Git branch/dirty-count polling (factory, debounced)
├── usage.ts           # Utility type guard for extracting usage tokens
├── utils.ts           # normalizeThinkingLevel, formatCount
├── types.ts           # Shared cross-cutting types (ColorFn, Totals, FooterInput, etc.)
└── *.test.ts          # Co-located vitest tests
```

## Key patterns & conventions

### Formatting

- **Tabs for indentation** — `.editorconfig` and `.oxfmtrc.json` both use `tabWidth: 1`. This is **unusually narrow tabs** (1 column), not 2-space or 4-space. This affects all editing.
- oxfmt: `singleQuote: false`, `trailingComma: "all"`, `printWidth: 100`, `semi: true` (migrated from prettier with `oxfmt --migrate prettier`)
- oxfmt reads `.gitignore` and `.prettierignore` patterns automatically — `dist/`, `node_modules/`, and `*.md` are skipped without an explicit ignore file

### Code style

- **ESM only**: `"type": "module"` in package.json. All internal imports use explicit `.js` extension (e.g., `import { Foo } from "./foo.js"`).
- **Private class fields** with `#` prefix (not `private` keyword) — e.g., `#config`, `#git`, `#footerEnabled`
- **Factory functions** for stateful modules: `createGitState()`, `createToksActivity()`, `createEventAdapter()` return handle objects with methods, not classes.
- **Comment section headers**: `// ── Section name ──` pattern used throughout for visual grouping.
- **No dependencies on `typescript` package** for type checking at runtime — TypeScript is dev-only (v6.0.3).
- **Terse error handling**: single-line try/catch blocks; errors logged with `[clean-footer]` prefix.

### Testing

- **Vitest** with co-located tests: `src/*.test.ts`
- Mock `node:child_process` with `vi.mock` and `vi.hoisted` for factory hoisting (see `git.test.ts` for pattern)
- Use `vi.useFakeTimers` for debounce/timer tests
- Helper factories like `makeInput()` and test themes (`plainTheme`, `captureTheme`) in renderer tests
- No coverage configuration configured

### Architecture & data flow

1. **Entry** (`index.ts`) registers a `default` export function receiving `ExtensionAPI`. It wires lifecycle events (`session_start`, `session_shutdown`, `model_select`, `message_start/end/update`, `tool_execution_start/end`, `user_bash`, `thinking_level_select`) to the `EventAdapter` returned by `createEventAdapter()`.
2. **EventAdapter** maintains state: config, git, toks activity, cached totals. On render, `snapshot(ctx)` returns a `FooterInput` for the renderer.
3. **Renderer** takes `FooterInput`, builds segment map (model, directory, git, context, tokens variants, toks, cost), selects layout tier by terminal width, then renders left/right with separator.
4. **Layout** (`src/layout.ts`) uses `@earendil-works/pi-tui`'s `visibleWidth` and `truncateToWidth` for CJK-aware string sizing.
5. **Git** state (`src/git.ts`) is debounced, uses generation counter to discard stale async results, silences ENOENT and non-zero exit codes.

### Configuration

- Load order: global (`~/.pi/agent/clean-footer.json`) → project (`.pi/clean-footer.json`). Project overrides global via shallow merge with nested merge for `modelAliases` and `colors`.
- Presets (`default`, `minimal`, `compact`, `dense`, `focus`, `muted`) set baseline values; explicit user config overrides them.
- `showCache` is deprecated — use `showCacheRead` and `showCacheWrites`.

### Notable gotchas

- **Tabs are 1 column wide** in `.editorconfig`. This is non-standard; editors may default to 4 or 8. Configure your editor to respect `.editorconfig`.
- **All `.ts` imports use `.js` extension** — this is required by ESM + TypeScript resolution. Adding `.ts` or omitting the extension will break.
- **`promisify` mock** in git tests needs special handling because Node's real `promisify` has built-in function special-casing that doesn't apply to `vi.fn()` mocks — see `src/git.test.ts` for the pattern.
- **`toksActivity.onMessageAbort()` is pre-wired for a future API event** that doesn't exist yet — not currently reachable.
- **No TypeScript config file** — `tsc` type-checking is done ad-hoc via `npx tsc` (see README for flags). The project relies on tsup's built-in type stripping for compilation.
- **Segment values in renderer are lazy** — token segments (`tokensFull`, `tokensNoCache`, `tokensTotal`) are closures computed only for the active layout to avoid unnecessary work.
