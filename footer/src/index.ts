import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_REFRESH_DEBOUNCE_MS = 500;

type Theme = ExtensionContext["ui"]["theme"];

type GitState = {
	inRepo: boolean;
	branch?: string;
	dirtyCount: number;
};

type Totals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

type FooterRuntime = {
	enabled: boolean;
	git: GitState;
	thinkingLevel?: string;
	refreshTimer?: ReturnType<typeof setTimeout>;
	requestRender?: () => void;
};

const runtime: FooterRuntime = {
	enabled: true,
	git: { inRepo: false, dirtyCount: 0 },
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("footer", {
		description: "Toggle or refresh the clean footer",
		handler: async (args, ctx) => {
			const command = args.trim();

			if (command === "refresh") {
				await refreshGit(ctx, true);
				runtime.requestRender?.();
				if (ctx.hasUI) ctx.ui.notify("Footer refreshed", "info");
				return;
			}

			runtime.enabled = !runtime.enabled;
			if (!ctx.hasUI) return;

			if (runtime.enabled) {
				runtime.thinkingLevel = normalizeThinkingLevel(pi.getThinkingLevel?.());
				installFooter(ctx);
				await refreshGit(ctx, true);
				ctx.ui.notify("Clean footer enabled", "info");
			} else {
				clearScheduledRefresh();
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		runtime.thinkingLevel = normalizeThinkingLevel(pi.getThinkingLevel?.());
		if (!ctx.hasUI || !runtime.enabled) return;
		installFooter(ctx);
		await refreshGit(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearScheduledRefresh();
		runtime.requestRender = undefined;
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	});

	pi.on("thinking_level_select", (event) => {
		runtime.thinkingLevel = normalizeThinkingLevel(event.level);
		runtime.requestRender?.();
	});

	pi.on("model_select", () => {
		runtime.requestRender?.();
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") runtime.requestRender?.();
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (["bash", "edit", "write"].includes(event.toolName))
			scheduleGitRefresh(ctx);
		runtime.requestRender?.();
	});

	pi.on("user_bash", (_event, ctx) => {
		scheduleGitRefresh(ctx);
	});
}

function installFooter(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	ctx.ui.setFooter((tui, theme) => {
		runtime.requestRender = () => tui.requestRender();

		return {
			invalidate() {},
			render(width: number): string[] {
				const modelSegment = formatModelSegment(ctx, theme);
				const dirSegment = theme.fg("dim", path.basename(ctx.cwd));
				const gitSegment = formatGitSegment(theme);
				const ctxSegment = formatContextSegment(ctx, theme);
				const totals = getTotals(ctx);
				const separator = theme.fg("dim", " | ");

				const leftFull = [modelSegment, dirSegment, gitSegment]
					.filter(Boolean)
					.join(separator);
				const leftMin = modelSegment;

				if (width >= 100) {
					return [
						joinLeftRight(
							leftFull,
							[
								ctxSegment,
								theme.fg("muted", formatTokenSegment(totals, "full")),
							].join(separator),
							width,
						),
					];
				}

				if (width >= 80) {
					return [
						joinLeftRight(
							leftFull,
							[
								ctxSegment,
								theme.fg("muted", formatTokenSegment(totals, "no-cache")),
							].join(separator),
							width,
						),
					];
				}

				if (width >= 60) {
					return [
						joinLeftRight(
							leftFull,
							[
								ctxSegment,
								theme.fg("muted", formatTokenSegment(totals, "total-only")),
							].join(separator),
							width,
						),
					];
				}

				if (width >= 40) return [joinLeftRight(leftFull, ctxSegment, width)];
				return [joinLeftRight(leftMin, ctxSegment, width)];
			},
		};
	});
}

function formatModelSegment(ctx: ExtensionContext, theme: Theme): string {
	const model = formatModelName(ctx.model?.id ?? "no-model");
	const effort = runtime.thinkingLevel ? ` • ${runtime.thinkingLevel}` : "";
	return theme.fg("accent", `${model}${effort}`);
}

function formatModelName(modelId: string): string {
	const lower = modelId.toLowerCase();
	const withoutProvider = lower.includes("/") ? lower.split("/").pop()! : lower;

	if (
		withoutProvider.includes("claude") &&
		withoutProvider.includes("sonnet")
	) {
		if (withoutProvider.includes("4-5") || withoutProvider.includes("4.5"))
			return "sonnet-4.5";
		if (withoutProvider.includes("4")) return "sonnet-4";
		return "sonnet";
	}

	if (withoutProvider.includes("claude") && withoutProvider.includes("opus"))
		return "opus";
	if (withoutProvider.includes("claude") && withoutProvider.includes("haiku"))
		return "haiku";

	const gpt5 = withoutProvider.match(/gpt-5(?:[.-][a-z0-9]+)*/);
	if (gpt5) return gpt5[0];

	const gpt4 = withoutProvider.match(/gpt-4(?:[.-][a-z0-9]+)*/);
	if (gpt4) return gpt4[0];

	const gemini = withoutProvider.match(/gemini-[a-z0-9.-]+/);
	if (gemini) return gemini[0].replace(/-preview.*/, "");

	return withoutProvider.length > 24
		? `${withoutProvider.slice(0, 21)}…`
		: withoutProvider;
}

function normalizeThinkingLevel(level: unknown): string | undefined {
	if (typeof level !== "string") return undefined;

	const normalized = level.toLowerCase();
	if (normalized === "medium") return "med";
	if (
		normalized === "extra-high" ||
		normalized === "extra_high" ||
		normalized === "x-high"
	)
		return "xhigh";
	if (["low", "med", "high", "xhigh"].includes(normalized)) return normalized;

	return undefined;
}

function getTotals(ctx: ExtensionContext): Totals {
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant")
			continue;

		const message = entry.message as AssistantMessage;
		totals.input += message.usage?.input ?? 0;
		totals.output += message.usage?.output ?? 0;
		totals.cacheRead += message.usage?.cacheRead ?? 0;
		totals.cacheWrite += message.usage?.cacheWrite ?? 0;
	}

	return totals;
}

function formatTokenSegment(
	totals: Totals,
	mode: "full" | "no-cache" | "total-only",
): string {
	const total = totals.input + totals.output;
	if (mode === "total-only") return `Σ${formatCount(total)}`;

	const base = `↑${formatCount(totals.input)} ↓${formatCount(totals.output)} Σ${formatCount(total)}`;
	if (mode === "no-cache") return base;

	return `${base} ↯${formatCount(totals.cacheRead)} ↥${formatCount(totals.cacheWrite)}`;
}

function formatContextSegment(ctx: ExtensionContext, theme: Theme): string {
	const usage = ctx.getContextUsage?.();
	const used = usage?.tokens ?? 0;
	const max = ctx.model?.contextWindow;
	const text = `ctx ${formatCount(used)}/${max ? formatCount(max) : "--"}`;

	if (!max || max <= 0) return theme.fg("dim", text);

	const ratio = used / max;
	if (ratio >= 0.85) return theme.fg("error", text);
	if (ratio >= 0.7) return theme.fg("warning", text);
	return theme.fg("success", text);
}

function formatGitSegment(theme: Theme): string | undefined {
	if (!runtime.git.inRepo || !runtime.git.branch) return undefined;

	const branch = theme.fg("success", runtime.git.branch);
	if (runtime.git.dirtyCount <= 0) return branch;

	return `${branch} ${theme.fg("warning", `●${runtime.git.dirtyCount}`)}`;
}

async function refreshGit(ctx: ExtensionContext, immediate = false) {
	try {
		const [branchResult, statusResult] = await Promise.all([
			execFileAsync("git", ["branch", "--show-current"], {
				cwd: ctx.cwd,
				timeout: 2_000,
			}),
			execFileAsync("git", ["status", "--porcelain"], {
				cwd: ctx.cwd,
				timeout: 2_000,
			}),
		]);

		const branch = branchResult.stdout.trim() || "detached";
		const dirtyCount = statusResult.stdout.split("\n").filter(Boolean).length;
		runtime.git = { inRepo: true, branch, dirtyCount };
	} catch {
		runtime.git = { inRepo: false, dirtyCount: 0 };
	}

	if (immediate) runtime.requestRender?.();
}

function scheduleGitRefresh(ctx: ExtensionContext) {
	clearScheduledRefresh();
	runtime.refreshTimer = setTimeout(() => {
		runtime.refreshTimer = undefined;
		void refreshGit(ctx, true);
	}, GIT_REFRESH_DEBOUNCE_MS);
}

function clearScheduledRefresh() {
	if (runtime.refreshTimer) clearTimeout(runtime.refreshTimer);
	runtime.refreshTimer = undefined;
}

function joinLeftRight(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width);
	if (!left) return truncateToWidth(right, width);

	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1) return truncateToWidth(left + " ".repeat(gap) + right, width);

	const half = Math.max(1, Math.floor((width - 1) / 2));
	return (
		truncateToWidth(left, half) + " " + truncateToWidth(right, width - half - 1)
	);
}

function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 1_000_000)
		return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}
