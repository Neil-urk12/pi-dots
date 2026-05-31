# Changelog

All notable changes to `@neilurk12/pi-clean-footer` are documented here.

## [0.4.2] — 2026-05-31

### Changed
- Consolidated `tokLabels` and `tokenEstimate` modules into `toksActivity`. Both functions (`normalizeToolLabel`, `estimateTokens`) now private — reduces public API surface.
- Net -108 lines. Tests migrated, all 363 pass.

---

## [0.4.1] — 2026-05-31

### Fixed
- **Git refresh hardening** — generation counter discards stale async results. ENOENT and non-zero exit codes silenced; unexpected errors logged.
- **Config validation** — rejects non-object JSON roots (array, null, string, number).
- **Render error boundary** — footer exceptions caught, returns `[]` instead of crashing.
- Git callbacks wrapped in try/catch to prevent refresh crash.

### Changed
- Deferred token segment computation to active layout only (perf).
- Extracted magic numbers to named constants (`GIT_TIMEOUT_MS`).

---


## [0.4.0] — 2026-05-31 · 17kb

### Added
- **Session cost display** — shows cumulative cost as `$x.xx` in footer. Auto-hides for zero-cost models. Enabled by default (`showCost: true`).
- Cost segment positioned first in right-side layout arrays.
- Expanded test suites: git module, index/lifecycle, renderer positioning assertions.

### Changed
- `engines` field added to package.json requiring Node >=18.

---

## [0.3.2] — 2026-05-29

### Added
- **Session cost display** — optional `cost` segment showing `$X.XX` format, auto-hides for zero-cost models.
- `showCost` config option (default: `true`).
- Git and index test suites. Renderer positioning assertions.

### Changed
- Cost reordered to first position in right-side layout arrays.

---

## [0.3.1] — 2026-05-29

### Fixed
- `extractOutputTokens` returns ≥0 instead of negative for zero-token messages.

### Changed
- `showCache` config option **deprecated** in favor of `showCacheRead` / `showCacheWrites`. Forwarding with console warning retained for backwards compatibility.
- Extracted `estimateTokens` to dedicated module with tests.
- Extracted `toksActivity` to standalone module.
- Docs updated for `showCache` deprecation.

---

## [0.2.8] — 2026-05-22 · 9kb

### Added
- **Tok/s speed display** — shows tokens-per-second rate in footer.
- **Live tok/s estimation during streaming** — CJK-aware character-class estimation using tiktoken cl100k_base empirical ratios.
- **Activity indicator during tool execution** — rotating dots animation with tool label (e.g., `bash…`, `edit…`).
- `toks` segment added to layout (visible at width ≥60).
- Prettier auto-formatting for all source files.

### Fixed
- Tok/s precision preserved. Token usage extraction properly typed.
- CJK punctuation weight lowered for more accurate estimation.
- CJK token estimation ranges expanded.
- `toks` segment moved to left side of footer.

### Changed
- Config, renderer, and cache token totals split into dedicated modules.
- Extracted `tokenEstimate.ts`, `toksActivity.ts`, `usage.ts` modules from monolithic index.

---

## [0.2.7] — 2026-05-17

### Added
- **Configurable footer layout engine** — custom layout definitions via config JSON.
- **Named footer presets** — `default`, `minimal`, `compact`, `dense`, `focus`, `muted`.
- `showCacheRead` and `showCacheWrites` flags (replacing monolithic `showCache`).
- Preset documentation in README.

### Fixed
- Skip layouts with no visible segments, fall back to default.
- Ensure resolved preset overrides user-supplied value.

---

## [0.2.5] — 2026-05-15

### Added
- **Layout engine** extracted into dedicated module.

### Changed
- Example image moved to CDN. README updated.

---

## [0.2.3] — 2026-05-15

### Added
- Vitest testing framework integrated.
- `formatModelName` extracted into dedicated module.

### Changed
- Segments merged into renderer module. Test infrastructure established.

---

## [0.2.2] — 2026-05-11

### Added
- **Build step** (tsup) reduces publish bundle size by 60%+.

### Changed
- Major refactor: footer rendering extracted into pure segment functions.
- Git, tokens, and renderer extracted into focused modules.
- `normalizeThinkingLevel` moved to utils module.
- `FooterLifecycle` class extracted for lifecycle management.
- `reload` made async with git state reset.

### Fixed
- `ui.notify` guarded with `hasUI` check.

---

## [0.2.1] — 2026-05-11

### Fixed
- Use raw GitHub URLs for images in README.

---

## [0.2.0] — 2026-05-11 · 9kb

### Changed
- Config loading extracted into dedicated module.

---

## [0.1.1] — 2026-05-09

### Added
- README with usage examples and example image.
- Footer configuration options.

### Changed
- Source folder renamed to `src/`, entry point to `index.ts`.
- Package name scoped to `@neilurk12/pi-clean-footer`.

---

## [0.1.0] — 2026-05-09 · 5kb

### Added
- Initial release of `@neilurk12/pi-clean-footer`.
- **Powerline-style footer** with 9 configurable segments: `model`, `directory`, `git`, `context`, `tokensFull`, `tokensNoCache`, `tokensTotal`, `toks`, `cost`.
- **6 presets**: `default`, `minimal`, `compact`, `dense`, `focus`, `muted`.
- **5 adaptive width tiers** (100+, 80+, 60+, 40+, <40) that hide/show segments based on terminal width.
- **Two-file layered config**: global (`~/.pi/agent/clean-footer.json`) + project (`.pi/clean-footer.json`). Project overrides global; nested objects merge.
- **Customizable**: separator, model aliases, 10-color theming, context warning/danger thresholds, git refresh debounce.
- **Commands**: `/footer` (toggle), `/footer refresh`, `/footer reload`, `/footer config`.
- **Event-driven git refresh** after file-changing tools and user bash commands (debounced 500ms).
- Smart model name shortening with pattern matching and explicit aliases.
- Thinking level display (low/med/high/xhigh).
- Build tooling: tsup for bundling, vitest for testing, TypeScript strict mode.
