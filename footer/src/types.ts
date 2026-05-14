// ── Shared cross-cutting types ─────────────────────────────────
//
// Types that travel across module seams (lifecycle → renderer,
// tokens → segments, etc.) live here. Domain-specific types
// (GitState, ResolvedConfig) stay with their owning modules.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.js";

/** Color adapter used by all segment formatters. */
export type ColorFn = (colorName: string, text: string) => string;

/** Token usage accumulator shape. */
export type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

/** Snapshot assembled by the lifecycle and fed to the renderer. */
export type FooterInput = {
	modelId: string;
	thinkingLevel?: string;
	directory?: string;
	gitBranch?: string;
	gitDirtyCount: number;
	contextUsed: number;
	contextMax?: number;
	totals: Totals;
	config: ResolvedConfig;
};

/** Convenience alias for the TUI theme object. */
export type Theme = ExtensionContext["ui"]["theme"];
