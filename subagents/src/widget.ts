import type { Theme, ThemeColor } from "@mariozechner/pi-coding-agent";
import { isLiveState, type AgentRun, type AgentState, type TeamMember } from "./types.ts";

export const AGENT_PALETTE: readonly string[] = [
	"#e06363", "#7ad9d9", "#f0a060", "#80b8e0", "#f0c060", "#7a9aff",
	"#c0d860", "#b48cff", "#80c878", "#d880e0", "#5dd4a3", "#f0a0c0",
];

const FEATURE_COLOR_HEX = "#1a1a1a";
const FACE_COLUMN_COUNT = 3;
const FACE_HORIZONTAL_PAD = 1;
const FACE_OUTER_WIDTH = FACE_COLUMN_COUNT + FACE_HORIZONTAL_PAD * 2;
const NAME_FACE_GAP = "  ";
const CHIP_SEPARATOR = "   ";
const TITLE_TEXT = "NANO TEAM";
const BORDER_HORIZONTAL_PAD = 1;
const BORDER_OUTER_OVERHEAD = 2 + 2 * BORDER_HORIZONTAL_PAD;

const STATUS_COLOR: Readonly<Record<AgentState, ThemeColor>> = {
	idle: "dim",
	thinking: "dim",
	working: "dim",
	done: "success",
	error: "error",
};

type FaceFrame = readonly [eyesRow: string, mouthRow: string];
type FaceVariant = readonly FaceFrame[];

const FACES_BY_STATE: Readonly<Record<AgentState, readonly FaceVariant[]>> = {
	idle: [
		[["─ ─", " z "], ["─ ─", "  z"], ["─ ─", " z "], ["─ ─", "z  "]],
		[["^ ^", "   "], ["^ ^", " _ "], ["^ ^", "   "], ["^ ^", " _ "]],
		[["· ·", "   "], ["· ·", " · "], ["· ·", "   "], ["· ·", " · "]],
		[["─ ─", "~~~"], ["─ ─", " ~ "], ["─ ─", "~~~"], ["─ ─", " ~ "]],
	],
	thinking: [
		[["o o", "   "], ["o o", ".  "], ["o o", ".. "], ["o o", "..."]],
		[["^ o", "   "], ["o ^", "   "], ["^ o", "   "], ["o ^", "   "]],
		[["' '", "   "], ["' '", " · "], ["' '", "   "], ["' '", " · "]],
		[["o O", " ~ "], ["O o", " ~ "], ["o O", " ~ "], ["O o", " ~ "]],
	],
	working: [
		[["o o", "\\_/"], ["O O", "\\_/"], ["o o", " o "], ["o o", "\\_/"]],
		[["─ ─", "─ ─"], ["─ ─", "─ ─"], ["─ ─", " ─ "], ["─ ─", "─ ─"]],
		[["─ ─", "==="], ["─ ─", "|||"], ["─ ─", "==="], ["─ ─", "|||"]],
		[["· ·", "\\_/"], ["· ·", " _ "], ["· ·", "\\_/"], ["· ·", " _ "]],
	],
	done: [
		[["- ^", "\\_/"], ["^ -", "\\_/"], ["- ^", "\\_/"], ["^ -", "\\_/"]],
		[["o o", "\\_/"], ["o o", " _ "], ["o o", "\\_/"], ["o o", " _ "]],
		[["· ·", "\\_/"], ["· ·", " _ "], ["· ·", "\\_/"], ["· ·", " _ "]],
		[["^ ^", "\\o/"], ["^ ^", " o "], ["^ ^", "\\o/"], ["^ ^", " o "]],
	],
	error: [
		[["x x", "/^\\"], ["X X", "/^\\"], ["x x", "/o\\"], ["x x", "/^\\"]],
		[["@ @", "/_\\"], ["@ @", "/o\\"], ["@ @", "/_\\"], ["@ @", "/o\\"]],
		[["! !", "/o\\"], ["! !", "/O\\"], ["! !", "/o\\"], ["! !", "/O\\"]],
		[["* *", "/_\\"], ["# #", "\\_/"], ["* *", "/_\\"], ["# #", "\\_/"]],
	],
};

for (const [state, variants] of Object.entries(FACES_BY_STATE)) {
	if (variants.length === 0) throw new Error(`no variants defined for state '${state}'`);
	for (const [variantIndex, frames] of variants.entries()) {
		if (frames.length === 0) throw new Error(`empty variant ${variantIndex} for state '${state}'`);
		for (const [eyes, mouth] of frames) {
			if (Array.from(eyes).length !== FACE_COLUMN_COUNT || Array.from(mouth).length !== FACE_COLUMN_COUNT) {
				throw new Error(`face frame for '${state}' variant ${variantIndex} has wrong column count: ${JSON.stringify([eyes, mouth])}`);
			}
		}
	}
}

const hexToRgbCache = new Map<string, readonly [number, number, number]>();

const hexToRgb = (hex: string): readonly [number, number, number] => {
	const cached = hexToRgbCache.get(hex);
	if (cached) return cached;
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const rgb: readonly [number, number, number] = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
	hexToRgbCache.set(hex, rgb);
	return rgb;
};

const ansiForeground = (hex: string, text: string): string => {
	const [red, green, blue] = hexToRgb(hex);
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
};

const ansiBackground = (hex: string, text: string): string => {
	const [red, green, blue] = hexToRgb(hex);
	return `\x1b[48;2;${red};${green};${blue}m${text}\x1b[49m`;
};

const hashString = (input: string): number => {
	let accumulator = 0;
	for (let index = 0; index < input.length; index++) {
		accumulator = (accumulator * 31 + input.charCodeAt(index)) >>> 0;
	}
	// Murmur3 finalizer — DJB2 alone clusters in the low bits, skewing `% smallN`.
	accumulator = Math.imul(accumulator ^ (accumulator >>> 16), 0x85ebca6b) >>> 0;
	accumulator = Math.imul(accumulator ^ (accumulator >>> 13), 0xc2b2ae35) >>> 0;
	return (accumulator ^ (accumulator >>> 16)) >>> 0;
};

const FALLBACK_COLOR = AGENT_PALETTE[0] ?? "#cccccc";
// Per-session salt: same agent name picks a different preferred color in each pi run while
// staying stable across renders within one run.
const COLOR_SESSION_KEY = Math.random().toString(36).slice(2);
const agentColorCache = new Map<string, string>();

// Hash-only assignment hits ~59% birthday-collision odds for 4 names in a 12-color palette and
// ~91% for 4 variants per state. Linear-probe over the visible group keeps the rendered row
// distinct; resetting `taken` once the pool is exhausted balances larger groups (8 agents → 2 each).
// Color is keyed by `agentName` (not `instanceId`) so concurrent runs of the same agent
// share one color — visual identity is by role, not by individual run.
const assignAgentColor = (inputs: readonly ChipInputBase[]): ReadonlyMap<string, string> => {
	const numColors = AGENT_PALETTE.length;
	const resolved = new Map<string, string>();
	const inUse = new Set<string>();
	for (const input of inputs) {
		const cached = agentColorCache.get(input.agentName);
		if (cached === undefined) continue;
		resolved.set(input.agentName, cached);
		inUse.add(cached);
	}
	for (const input of inputs) {
		if (resolved.has(input.agentName)) continue;
		let chosen = hashString(`${input.agentName}:${COLOR_SESSION_KEY}`) % numColors;
		for (let probe = 0; probe < numColors; probe++) {
			const candidate = AGENT_PALETTE[chosen] ?? FALLBACK_COLOR;
			if (!inUse.has(candidate)) break;
			chosen = (chosen + 1) % numColors;
		}
		const color = AGENT_PALETTE[chosen] ?? FALLBACK_COLOR;
		inUse.add(color);
		agentColorCache.set(input.agentName, color);
		resolved.set(input.agentName, color);
	}
	return resolved;
};

/**
 * Variant index is keyed by `instanceId` (not agent name) so two concurrent
 * live runs of the same agent get distinct faces. The color stays shared
 * by agentName; the variant (face frame selection seed) varies by id.
 */
const assignVariantIndex = (inputs: readonly ChipInputBase[]): ReadonlyMap<string, number> => {
	const byState = new Map<AgentState, ChipInputBase[]>();
	for (const input of inputs) {
		const list = byState.get(input.state) ?? [];
		list.push(input);
		byState.set(input.state, list);
	}
	const assignments = new Map<string, number>();
	for (const [state, group] of byState) {
		const numVariants = FACES_BY_STATE[state].length;
		const taken = new Set<number>();
		for (const input of group) {
			if (taken.size >= numVariants) taken.clear();
			let chosen = hashString(`${input.instanceId}:${state}`) % numVariants;
			for (let probe = 0; probe < numVariants && taken.has(chosen); probe++) {
				chosen = (chosen + 1) % numVariants;
			}
			taken.add(chosen);
			assignments.set(input.instanceId, chosen);
		}
	}
	return assignments;
};

const selectFrame = (seed: string, state: AgentState, variantIndex: number, frameIndex: number): FaceFrame => {
	const variants = FACES_BY_STATE[state];
	const variant = variants[variantIndex % variants.length]!;
	const slot = (frameIndex + (hashString(seed) % variant.length)) % variant.length;
	return variant[slot]!;
};

const faceRowCache = new Map<string, string>();

const renderFaceRow = (row: string, faceColor: string): string => {
	const cacheKey = `${row}|${faceColor}`;
	const cached = faceRowCache.get(cacheKey);
	if (cached) return cached;
	let features = "";
	for (const character of row) {
		features += character === " " ? " " : ansiForeground(FEATURE_COLOR_HEX, character);
	}
	const padded = " ".repeat(FACE_HORIZONTAL_PAD) + features + " ".repeat(FACE_HORIZONTAL_PAD);
	const rendered = ansiBackground(faceColor, padded);
	faceRowCache.set(cacheKey, rendered);
	return rendered;
};

const truncateToColumns = (text: string, maxColumns: number): string => {
	if (maxColumns <= 0) return "";
	const chars = Array.from(text);
	if (chars.length <= maxColumns) return text;
	if (maxColumns === 1) return "…";
	return `${chars.slice(0, maxColumns - 1).join("")}…`;
};

const padToColumns = (text: string, columns: number): string => {
	const length = Array.from(text).length;
	return length >= columns ? text : text + " ".repeat(columns - length);
};

/**
 * Per-chip input. `name` is the visible label (the `instanceId`, e.g.
 * `blitz-1`); `agentName` is the underlying agent (`blitz`) and is used
 * for color assignment; `instanceId` is used for variant assignment.
 */
type ChipInput = Readonly<{
	name: string;
	agentName: string;
	instanceId: string;
	role: string;
	state: AgentState;
	activity: string | null;
	variantIndex: number;
	faceColor: string;
}>;
type ChipInputBase = Omit<ChipInput, "variantIndex" | "faceColor">;
type ChipFrame = Readonly<{
	topBorderLine: string;
	eyesLine: string;
	mouthLine: string;
	activityLine: string;
	bottomBorderLine: string;
	visibleWidth: number;
}>;
type BorderStyling = Readonly<{ wrapLeft: string; wrapRight: string }>;

const buildChipFrame = (input: ChipInput, frameIndex: number, theme: Theme, border: BorderStyling): ChipFrame => {
	const [eyesRow, mouthRow] = selectFrame(input.instanceId, input.state, input.variantIndex, frameIndex);
	const statusSuffix = ` (${input.state})`;
	const statusSuffixWidth = Array.from(statusSuffix).length;
	const labelWidth = Math.max(input.name.length + statusSuffixWidth, input.role.length);
	const innerContentWidth = FACE_OUTER_WIDTH + NAME_FACE_GAP.length + labelWidth;
	const visibleWidth = innerContentWidth + BORDER_OUTER_OVERHEAD;

	const nameTrailingPadWidth = Math.max(0, labelWidth - input.name.length - statusSuffixWidth);
	const nameLine = `${theme.fg("text", input.name)}${theme.fg(STATUS_COLOR[input.state], statusSuffix)}${" ".repeat(nameTrailingPadWidth)}`;
	const roleStyled = theme.fg("muted", padToColumns(input.role, labelWidth));

	const activityRaw = input.activity?.trim() ?? "";
	const activityFitted = padToColumns(truncateToColumns(activityRaw, innerContentWidth), innerContentWidth);
	const activityStyled = activityRaw.length > 0 ? theme.fg("dim", activityFitted) : activityFitted;

	const horizontal = "─".repeat(innerContentWidth + 2 * BORDER_HORIZONTAL_PAD);
	const eyesContent = `${renderFaceRow(eyesRow, input.faceColor)}${NAME_FACE_GAP}${nameLine}`;
	const mouthContent = `${renderFaceRow(mouthRow, input.faceColor)}${NAME_FACE_GAP}${roleStyled}`;

	return {
		topBorderLine: theme.fg("borderMuted", `╭${horizontal}╮`),
		eyesLine: `${border.wrapLeft}${eyesContent}${border.wrapRight}`,
		mouthLine: `${border.wrapLeft}${mouthContent}${border.wrapRight}`,
		activityLine: `${border.wrapLeft}${activityStyled}${border.wrapRight}`,
		bottomBorderLine: theme.fg("borderMuted", `╰${horizontal}╯`),
		visibleWidth,
	};
};

/**
 * Build one chip input per live run. Live = state `thinking` or `working`.
 * Completed (done/error) runs are excluded from the chips; the caller adds
 * a per-name completion footer separately.
 *
 * Two instances of the same agent produce two chips — that's the whole
 * point of the instance model. Chip `name` is the `instanceId` (e.g.
 * `blitz-1`, `blitz-2`); `agentName` carries the underlying agent name
 * for color keying.
 */
const collectChipInputs = (
	team: ReadonlyMap<string, TeamMember>,
	runs: readonly AgentRun[],
): readonly ChipInputBase[] => {
	const ordered: ChipInputBase[] = [];
	// Track which `instanceId`s we've already emitted so a caller passing
	// the same run twice doesn't produce duplicate chips.
	const seen = new Set<string>();
	for (const run of runs) {
		if (seen.has(run.instanceId)) continue;
		if (!isLiveState(run.state)) continue;
		seen.add(run.instanceId);
		const member = team.get(run.name);
		ordered.push({
			name: run.instanceId,
			agentName: run.name,
			instanceId: run.instanceId,
			role: member?.role ?? "?",
			state: run.state,
			activity: run.activity,
		});
	}
	return ordered;
};

/**
 * Count completed runs per agent name. Live runs are excluded — the chip
 * rendering already covers them.
 */
const countCompletedByName = (runs: readonly AgentRun[]): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>();
	for (const run of runs) {
		if (isLiveState(run.state)) continue;
		counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
	}
	return counts;
};

const partitionIntoRows = (chips: readonly ChipFrame[], maxRowWidth: number): readonly (readonly ChipFrame[])[] => {
	const safeMaxWidth = Math.max(FACE_OUTER_WIDTH + NAME_FACE_GAP.length + 2 + BORDER_OUTER_OVERHEAD, maxRowWidth);
	const rows: ChipFrame[][] = [];
	let current: ChipFrame[] = [];
	let currentWidth = 0;
	for (const chip of chips) {
		const separatorWidth = current.length > 0 ? CHIP_SEPARATOR.length : 0;
		if (current.length > 0 && currentWidth + separatorWidth + chip.visibleWidth > safeMaxWidth) {
			rows.push(current);
			current = [chip];
			currentWidth = chip.visibleWidth;
		} else {
			current.push(chip);
			currentWidth += separatorWidth + chip.visibleWidth;
		}
	}
	if (current.length > 0) rows.push(current);
	return rows;
};

export const renderChips = (
	runs: readonly AgentRun[],
	team: ReadonlyMap<string, TeamMember>,
	terminalCols: number,
	theme: Theme,
	frameIndex: number,
): string[] => {
	const baseInputs = collectChipInputs(team, runs);
	if (baseInputs.length === 0) return [];
	const variantByInstance = assignVariantIndex(baseInputs);
	const colorByAgent = assignAgentColor(baseInputs);
	const innerPad = " ".repeat(BORDER_HORIZONTAL_PAD);
	const verticalBar = theme.fg("borderMuted", "│");
	const border: BorderStyling = {
		wrapLeft: `${verticalBar}${innerPad}`,
		wrapRight: `${innerPad}${verticalBar}`,
	};
	const frames = baseInputs.map((input) =>
		buildChipFrame(
			{
				...input,
				variantIndex: variantByInstance.get(input.instanceId) ?? 0,
				faceColor: colorByAgent.get(input.agentName) ?? FALLBACK_COLOR,
			},
			frameIndex,
			theme,
			border,
		),
	);
	const rows = partitionIntoRows(frames, Math.max(0, terminalCols - 2));
	const output: string[] = [theme.bold(theme.fg("accent", TITLE_TEXT))];
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const row = rows[rowIndex]!;
		output.push(
			row.map((chip) => chip.topBorderLine).join(CHIP_SEPARATOR),
			row.map((chip) => chip.eyesLine).join(CHIP_SEPARATOR),
			row.map((chip) => chip.mouthLine).join(CHIP_SEPARATOR),
			row.map((chip) => chip.activityLine).join(CHIP_SEPARATOR),
			row.map((chip) => chip.bottomBorderLine).join(CHIP_SEPARATOR),
		);
		if (rowIndex < rows.length - 1) output.push("");
	}

	// Append a per-name footer for completed runs. Order matches
	// team.values() for predictability; legacy names not in the current
	// team (e.g. a renamed agent) go last.
	const completed = countCompletedByName(runs);
	if (completed.size > 0) {
		const segments: string[] = [];
		for (const member of team.values()) {
			const count = completed.get(member.name);
			if (count === undefined) continue;
			segments.push(`${member.name}: ${count} completed`);
		}
		for (const [name, count] of completed) {
			if (team.has(name)) continue;
			segments.push(`${name}: ${count} completed`);
		}
		output.push("");
		output.push(theme.fg("muted", segments.join(" · ")));
	}

	return output;
};
