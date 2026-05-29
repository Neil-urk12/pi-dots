import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./configSchema.js";

/** Color adapter used by segment formatters. */
export type ColorFn = (colorName: string, text: string) => string;

/** Snapshot assembled by the lifecycle and fed to the renderer. */
export type HeaderInput = {
	name: string;
	gitBranch?: string;
	modelId: string;
	directory: string;
	config: ResolvedConfig;
};

/** Convenience alias for the TUI theme object. */
export type Theme = ExtensionContext["ui"]["theme"];
