/**
 * Subagent UI Helpers
 *
 * Pure formatting functions for status bar, overlay panel,
 * and final reports. All functions are stateless and side-effect free.
 *
 * Icon mode is controlled by the `OH_PI_PLAIN_ICONS` environment variable.
 * When set to "1" or "true", all icons fall back to ASCII-safe glyphs.
 */
import type { SubagentMetrics, SubagentPhase, RunningSubagent } from "./types.js";

/** Check whether plain (ASCII-safe) icon mode is active. */
function isPlain(): boolean {
	return process.env.OH_PI_PLAIN_ICONS === "1" || process.env.OH_PI_PLAIN_ICONS === "true";
}

/**
 * Format a millisecond duration into a human-readable string like `42s` or `3m12s`.
 */
export function formatDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${s % 60}s`;
}

/**
 * Format a USD cost value. Shows 4 decimal places for sub-cent values,
 * 2 decimal places otherwise.
 */
export function formatCost(cost: number): string {
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/**
 * Format a token count with k/M suffixes for readability.
 */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	return n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

// ═══ Phase Icons ═══

const EMOJI_PHASE_ICONS: Record<string, string> = {
	launching: "⚡",
	running: "⚡",
	done: "✓",
	failed: "✗",
};

const PLAIN_PHASE_ICONS: Record<string, string> = {
	launching: "[>>]",
	running: "[w]",
	done: "[ok]",
	failed: "[ERR]",
};

const PHASE_LABELS: Record<string, string> = {
	launching: "LAUNCHING",
	running: "RUNNING",
	done: "COMPLETE",
	failed: "FAILED",
};

// ═══ Agent Icons ═══

const EMOJI_AGENT_ICONS: Record<string, string> = {
	blitz: "🔍",
	seeker: "🌐",
	grind: "⚒️",
};

const PLAIN_AGENT_ICONS: Record<string, string> = {
	blitz: "[?]",
	searcher: "[w]",
	grind: "[!]",
};

/**
 * Get the icon for a subagent phase string.
 */
export function phaseIcon(phase: SubagentPhase | string): string {
	const map = isPlain() ? PLAIN_PHASE_ICONS : EMOJI_PHASE_ICONS;
	return map[phase] || (isPlain() ? "[sa]" : "⚡");
}

/**
 * Get the uppercase label for a subagent phase string.
 */
export function phaseLabel(phase: SubagentPhase | string): string {
	return PHASE_LABELS[phase] || phase.toUpperCase();
}

/**
 * Get the icon for an agent type (blitz, seeker, grind).
 */
export function agentIcon(agent: string): string {
	const map = isPlain() ? PLAIN_AGENT_ICONS : EMOJI_AGENT_ICONS;
	return map[agent] || (isPlain() ? "[sa]" : "⚡");
}

/** Subagent icon — ⚡ or [sa] depending on icon mode. */
export function subagentIcon(): string {
	return isPlain() ? "[sa]" : "⚡";
}

/** Check mark — ✓ or [ok]. */
export function checkMark(): string {
	return isPlain() ? "[ok]" : "✓";
}

/** Cross mark — ✗ or [x]. */
export function crossMark(): string {
	return isPlain() ? "[x]" : "✗";
}

/**
 * Render an ASCII progress bar like [####------].
 */
export function progressBar(progress: number, width = 14): string {
	const p = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
	const filled = Math.round(width * p);
	return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
}

/**
 * Trim text to max length with ellipsis.
 */
export function trim(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * Format usage stats for display.
 */
export function formatUsageStats(
	usage: SubagentMetrics,
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(formatCost(usage.cost));
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Build a status summary for a single running subagent.
 */
export function buildSubagentStatusText(s: RunningSubagent): string {
	const elapsed = formatDuration(Date.now() - s.startedAt);
	const phase = s.phase;
	const icon = phaseIcon(phase);
	const lines: string[] = [
		`${subagentIcon()} ${icon} ${trim(s.task, 80)}`,
		`ID: ${s.id}`,
		`Agent: ${s.agent}`,
		`${phaseLabel(phase)} │ ${formatUsageStats(s.metrics, s.metrics.model)} │ ${elapsed}`,
	];
	if (s.logs.length > 0) {
		lines.push(`Last: ${trim(s.logs[s.logs.length - 1].text, 100)}`);
	}
	return lines.join("\n");
}

/**
 * Build a status summary for all running subagents.
 */
export function buildAllStatusText(running: Map<string, RunningSubagent>): string {
	if (running.size === 0) return "No subagents are currently running.";
	if (running.size === 1) {
		const s = running.values().next().value;
		return s ? buildSubagentStatusText(s) : "No subagents are currently running.";
	}
	const parts: string[] = [`${running.size} subagents running:\n`];
	for (const s of running.values()) {
		parts.push(`── [${s.id}] ──\n${buildSubagentStatusText(s)}\n`);
	}
	return parts.join("\n");
}

/**
 * Build the final markdown report summarizing a subagent run.
 */
export function buildReport(s: RunningSubagent): string {
	const elapsed = s.finishedAt ? formatDuration(s.finishedAt - s.startedAt) : "?";
	const ok = s.phase === "done";
	return [
		`## ${subagentIcon()} Subagent Report`,
		`**Agent:** ${s.agent}`,
		`**Task:** ${s.task}`,
		`**Status:** ${phaseIcon(s.phase)} ${phaseLabel(s.phase)} │ ${formatCost(s.metrics.cost)}`,
		`**Duration:** ${elapsed}`,
		`**Usage:** ${formatUsageStats(s.metrics, s.metrics.model)}`,
	].join("\n");
}
