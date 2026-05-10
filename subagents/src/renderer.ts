import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	Markdown,
	Spacer,
	Text,
} from "@mariozechner/pi-tui";
import type { AgentResult, Details } from "./types";
import { formatDuration, formatTokens, truncLine } from "./format";

export type Theme = ExtensionContext["ui"]["theme"];

export interface SubagentCallArgs {
	agent?: string;
	task?: string;
	tasks?: Array<{ agent: string; task: string; cwd?: string }>;
	cwd?: string;
}

export interface SubagentRenderResult {
	content: Array<{ type: string; text: string }>;
	details?: Details;
}

export function getTermWidth(): number {
	return process.stdout.columns || 120;
}

export function renderAgentProgress(
	r: AgentResult,
	theme: Theme,
	expanded: boolean,
	termWidth: number,
): Container {
	const c = new Container();
	const prog = r.progress;
	const isRunning = prog.status === "running";
	const isPending = prog.status === "pending";

	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	const stats = `${prog.toolCount} tools · ${formatTokens(prog.tokens)} tok · ${formatDuration(prog.durationMs)}`;
	const modelStr = r.model ? theme.fg("dim", ` (${r.model})`) : "";
	c.addChild(
		new Text(
			truncLine(
				`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${modelStr} — ${theme.fg("dim", stats)}`,
				termWidth,
			),
			0,
			0,
		),
	);

	if (expanded) {
		c.addChild(new Text(theme.fg("dim", `Task: ${r.task}`), 0, 0));
	} else {
		const flat = r.task.replace(/\n/g, " ");
		c.addChild(new Text(truncLine(theme.fg("dim", `Task: ${flat}`), termWidth), 0, 0));
	}

	if (isRunning && prog.currentTool) {
		const toolLine = prog.currentToolArgs
			? `${prog.currentTool}: ${prog.currentToolArgs}`
			: prog.currentTool;
		if (expanded) {
			c.addChild(new Text(theme.fg("warning", `▸ ${toolLine}`), 0, 0));
		} else {
			c.addChild(
				new Text(truncLine(theme.fg("warning", `▸ ${toolLine}`), termWidth), 0, 0),
			);
		}
	}

	const toolsToShow = prog.recentTools;
	for (const t of toolsToShow) {
		const line = `  ${t.tool}: ${t.args}`;
		if (expanded) {
			c.addChild(new Text(theme.fg("muted", line), 0, 0));
		} else {
			c.addChild(new Text(truncLine(theme.fg("muted", line), termWidth), 0, 0));
		}
	}

	if (prog.lastMessage) {
		c.addChild(new Spacer(1));
		if (expanded) {
			c.addChild(new Text(theme.fg("text", prog.lastMessage), 0, 0));
		} else {
			c.addChild(
				new Text(truncLine(theme.fg("text", prog.lastMessage), termWidth), 0, 0),
			);
		}
	}

	if (!isRunning && r.output && expanded) {
		c.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		c.addChild(new Markdown(r.output, 0, 0, mdTheme));
	}

	c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (r.usage.turns)
		usageParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
	if (r.usage.input) usageParts.push(`in:${formatTokens(r.usage.input)}`);
	if (r.usage.output) usageParts.push(`out:${formatTokens(r.usage.output)}`);
	if (r.usage.cacheRead)
		usageParts.push(`cR:${formatTokens(r.usage.cacheRead)}`);
	if (r.usage.cacheWrite)
		usageParts.push(`cW:${formatTokens(r.usage.cacheWrite)}`);
	if (r.usage.cost) usageParts.push(`$${r.usage.cost.toFixed(4)}`);
	if (usageParts.length) {
		c.addChild(new Text(theme.fg("dim", usageParts.join(" · ")), 0, 0));
	}

	if (prog.error) {
		if (expanded) {
			c.addChild(new Text(theme.fg("error", `Error: ${prog.error}`), 0, 0));
		} else {
			c.addChild(
				new Text(truncLine(theme.fg("error", `Error: ${prog.error}`), termWidth), 0, 0),
			);
		}
	}

	return c;
}

export function renderSubagentCall(
	args: SubagentCallArgs,
	theme: Theme,
): Text {
	if (args.tasks && args.tasks.length > 0) {
		const agentNames = args.tasks.map((t) => t.agent).join(", ");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks: ${agentNames})`)}`,
			0,
			0,
		);
	}
	if (args.agent) {
		const taskPreview = args.task
			? (args.task.length > 60
					? args.task.slice(0, 60) + "…"
					: args.task
				).replace(/\n/g, " ")
			: "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
			0,
			0,
		);
	}
	return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
}

export function renderSubagentResult(
	result: SubagentRenderResult,
	options: { expanded: boolean },
	theme: Theme,
	termWidth: number,
): Container {
	const details = result.details;
	if (!details?.results?.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		return new Text(text.slice(0, 200), 0, 0) as unknown as Container;
	}

	const expanded = options.expanded;
	const c = new Container();

	if (details.mode === "parallel") {
		const ok = details.results.filter((r) => r.exitCode === 0).length;
		const running = details.results.filter(
			(r) => r.progress?.status === "running",
		).length;
		const totalIcon =
			running > 0
				? theme.fg("warning", "⟳")
				: ok === details.results.length
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");

		const totalDuration = Math.max(
			...details.results.map((r) => r.progress?.durationMs || 0),
		);
		const totalTokens = details.results.reduce(
			(s, r) => s + (r.progress?.tokens || 0),
			0,
		);
		c.addChild(
			new Text(
				truncLine(
					`${totalIcon} ${theme.fg("toolTitle", theme.bold("parallel"))} ${ok}/${details.results.length} completed · ${formatTokens(totalTokens)} tok · ${formatDuration(totalDuration)}`,
					termWidth,
				),
				0,
				0,
			),
		);
		c.addChild(new Spacer(1));

		for (let i = 0; i < details.results.length; i++) {
			const r = details.results[i];
			c.addChild(renderAgentProgress(r, theme, expanded, termWidth));
			if (i < details.results.length - 1) c.addChild(new Spacer(1));
		}
	} else {
		const r = details.results[0];
		c.addChild(renderAgentProgress(r, theme, expanded, termWidth));
	}

	return c;
}
