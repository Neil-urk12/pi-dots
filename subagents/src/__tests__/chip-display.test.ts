import { describe, expect, test } from "bun:test";
import {
	type ChipDisplay,
	type ChipDisplayDeps,
	WIDGET_KEY,
	WIDGET_PLACEMENT,
	FLUSH_DEBOUNCE_MS,
	ANIMATION_FRAME_MS,
	createChipDisplay,
	formatStatusText,
	renderChips,
} from "../chip-display.ts";
import { FakeClock, SpyWidgetSink, makeMember, makeRun, stubTheme } from "./helpers.ts";
import type { AgentRun, AgentState, TeamMember } from "../types.ts";

const buildDeps = (overrides: Partial<ChipDisplayDeps> = {}) => {
	const clock = new FakeClock();
	const sink = new SpyWidgetSink();
	const chipDisplay = createChipDisplay({
		clock,
		sink,
		getRunner: () => ({ list: () => [makeRun("alpha", "working")] }),
		getTeam: () => new Map([["alpha", makeMember("alpha")]]),
		getCols: () => 120,
		theme: stubTheme,
		...overrides,
	});
	return { clock, sink, chipDisplay };
};

describe("ChipDisplay — tracer bullet", () => {
	test("schedule() debounces then flushes rendered lines to the sink", () => {
		const { clock, sink, chipDisplay } = buildDeps();

		chipDisplay.schedule();
		expect(sink.calls).toHaveLength(0);

		clock.advance(FLUSH_DEBOUNCE_MS);

		expect(sink.calls).toHaveLength(1);
		expect(sink.last?.key).toBe(WIDGET_KEY);
		expect(sink.last?.placement).toBe(WIDGET_PLACEMENT);
		expect(sink.last?.lines).toBeDefined();
		expect(sink.last!.lines!.length).toBeGreaterThan(0);
	});
});

describe("ChipDisplay — debounce coalescing", () => {
	test("multiple schedule() calls within the window produce one flush", () => {
		const { clock, sink, chipDisplay } = buildDeps();

		chipDisplay.schedule();
		chipDisplay.schedule();
		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS - 1);
		expect(sink.calls).toHaveLength(0);

		clock.advance(1);
		expect(sink.calls).toHaveLength(1);

		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);
	});
});

describe("ChipDisplay — animation lifecycle", () => {
	test("arms an interval when a live agent is present after flush", () => {
		const { clock, sink, chipDisplay } = buildDeps();

		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		clock.advance(ANIMATION_FRAME_MS);
		expect(sink.calls).toHaveLength(2);

		clock.advance(ANIMATION_FRAME_MS);
		expect(sink.calls).toHaveLength(3);
	});

	test("disarms the interval when no live agent remains", () => {
		const runs = [makeRun("alpha", "working")];
		const { clock, sink, chipDisplay } = buildDeps({
			getRunner: () => ({ list: () => runs }),
		});

		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		runs[0] = makeRun("alpha", "done");

		clock.advance(ANIMATION_FRAME_MS);
		expect(sink.calls).toHaveLength(2);

		clock.advance(ANIMATION_FRAME_MS * 5);
		expect(sink.calls).toHaveLength(2);
	});
});

describe("ChipDisplay — cancel", () => {
	test("clears both the pending debounce and the animation interval", () => {
		const { clock, sink, chipDisplay } = buildDeps();

		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		chipDisplay.cancel();
		clock.advance(ANIMATION_FRAME_MS * 10);
		expect(sink.calls).toHaveLength(1);
	});

	test("is idempotent — safe to call when nothing is pending", () => {
		const { clock, sink, chipDisplay } = buildDeps();

		expect(() => chipDisplay.cancel()).not.toThrow();
		expect(() => chipDisplay.cancel()).not.toThrow();

		clock.advance(10_000);
		expect(sink.calls).toHaveLength(0);
	});
});

describe("ChipDisplay — dispose", () => {
	test("clears the widget, cancels pending timers and animation interval", () => {
		const { clock, sink, chipDisplay } = buildDeps();

		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		chipDisplay.dispose();
		expect(sink.calls).toHaveLength(2);
		expect(sink.last?.lines).toBeUndefined();

		clock.advance(ANIMATION_FRAME_MS * 10);
		expect(sink.calls).toHaveLength(2);
	});
});

describe("ChipDisplay — empty output", () => {
	test("writes undefined to the sink when no lines are rendered", () => {
		const { clock, sink, chipDisplay } = buildDeps({
			getRunner: () => ({ list: () => [] }),
		});

		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);

		expect(sink.calls).toHaveLength(1);
		expect(sink.last?.lines).toBeUndefined();
	});
});

describe("ChipDisplay — runner disappears", () => {
	test("getRunner() returning null stops the animation and writes undefined", () => {
		let runner: { list: () => AgentRun[] } | null = { list: () => [makeRun("alpha", "working")] };
		const { clock, sink, chipDisplay } = buildDeps({
			getRunner: () => runner,
		});

		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);
		expect(sink.last?.lines).toBeDefined();

		runner = null;
		clock.advance(ANIMATION_FRAME_MS);
		expect(sink.calls).toHaveLength(2);
		expect(sink.last?.lines).toBeUndefined();

		clock.advance(ANIMATION_FRAME_MS * 5);
		expect(sink.calls).toHaveLength(2);
	});
});

describe("ChipDisplay — tick escape hatch", () => {
	test("tick(now) flushes immediately, bypassing the debounce", () => {
		const clock = new FakeClock();
		const sink = new SpyWidgetSink();
		const chipDisplay = createChipDisplay({
			clock,
			sink,
			getRunner: () => ({ list: () => [makeRun("alpha", "done")] }),
			getTeam: () => new Map([["alpha", makeMember("alpha")]]),
			getCols: () => 120,
			theme: stubTheme,
		});

		chipDisplay.tick(0);
		expect(sink.calls).toHaveLength(1);
		expect(clock.pending()).toBe(0);

		chipDisplay.tick(1000);
		expect(sink.calls).toHaveLength(2);
		expect(clock.pending()).toBe(0);
	});

	test("frame index advances between successive ticks", () => {
		const clock = new FakeClock();
		const sink = new SpyWidgetSink();
		const chipDisplay = createChipDisplay({
			clock,
			sink,
			getRunner: () => ({ list: () => [makeRun("alpha", "thinking")] }),
			getTeam: () => new Map([["alpha", makeMember("alpha")]]),
			getCols: () => 120,
			theme: stubTheme,
		});

		for (let frame = 0; frame < 4; frame++) {
			chipDisplay.tick(frame * ANIMATION_FRAME_MS);
		}

		expect(sink.calls).toHaveLength(4);
		const distinctOutputs = new Set(sink.calls.map((c) => c.lines!.join("\n")));
		expect(distinctOutputs.size).toBeGreaterThan(1);
	});
});

describe("formatStatusText", () => {
	const team = (size: number): Map<string, TeamMember> => {
		const m = new Map<string, TeamMember>();
		for (let i = 0; i < size; i++) m.set(`a${i}`, makeMember(`a${i}`));
		return m;
	};

	test("returns undefined when no agents are live", () => {
		const runs = [makeRun("a0", "done"), makeRun("a1", "error")];
		expect(formatStatusText(runs, team(2))).toBeUndefined();
	});

	test("returns undefined when no runs exist", () => {
		expect(formatStatusText([], team(3))).toBeUndefined();
	});

	test("lists a single live agent without an idle count", () => {
		const runs = [makeRun("scout", "thinking")];
		expect(formatStatusText(runs, team(1))).toBe("scout: thinking");
	});

	test("joins multiple live agents with ' · '", () => {
		const runs = [makeRun("scout", "thinking"), makeRun("worker", "working")];
		expect(formatStatusText(runs, team(2))).toBe("scout: thinking · worker: working");
	});

	test("appends the idle count when team has members without live runs", () => {
		const runs = [makeRun("scout", "working")];
		expect(formatStatusText(runs, team(3))).toBe("scout: working · 2 idle");
	});

	test("ignores terminal agents when computing live and idle counts", () => {
		const runs = [makeRun("a0", "working"), makeRun("a1", "done"), makeRun("a2", "error")];
		// Only `a0` is live. a1, a2 are terminal (not counted as idle because they have runs).
		// team size = 4 → idle = 4 - 1 = 3
		expect(formatStatusText(runs, team(4))).toBe("a0: working · 3 idle");
	});
});

describe("ChipDisplay — setStatus integration", () => {
	const captureStatus = (): { calls: (string | undefined)[]; push: (text: string | undefined) => void } => {
		const calls: (string | undefined)[] = [];
		return { calls, push: (text) => calls.push(text) };
	};

	test("calls setStatus with the live-agent summary on flush", () => {
		const status = captureStatus();
		const { clock, chipDisplay } = buildDeps({ setStatus: status.push });
		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(status.calls).toEqual(["alpha: working"]);
	});

	test("clears the status when no agents are live", () => {
		const status = captureStatus();
		const runs = [makeRun("alpha", "working")];
		const { clock, chipDisplay } = buildDeps({
			setStatus: status.push,
			getRunner: () => ({ list: () => runs }),
		});
		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		// First flush: live
		expect(status.calls[status.calls.length - 1]).toBe("alpha: working");
		// Agent finishes; next animation tick clears the status
		runs[0] = makeRun("alpha", "done");
		clock.advance(ANIMATION_FRAME_MS);
		expect(status.calls[status.calls.length - 1]).toBeUndefined();
	});

	test("dispose() clears the status", () => {
		const status = captureStatus();
		const { clock, chipDisplay } = buildDeps({ setStatus: status.push });
		chipDisplay.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(status.calls[status.calls.length - 1]).toBe("alpha: working");
		chipDisplay.dispose();
		expect(status.calls[status.calls.length - 1]).toBeUndefined();
	});

	test("does not throw when setStatus is omitted", () => {
		const { clock, chipDisplay } = buildDeps();
		chipDisplay.schedule();
		expect(() => clock.advance(FLUSH_DEBOUNCE_MS)).not.toThrow();
	});
});

// ── renderChips — direct rendering tests (no animation loop) ──────────
//
// These exercise the pure rendering pipeline without going through the
// chipDisplay factory's debounce/animation seam. Tests can pin down layout
// invariants (row partition, completion footer, palette reuse) that the
// lifecycle tests can only assert indirectly via sink.calls.

describe("renderChips — empty and trivial inputs", () => {
	const team = new Map<string, TeamMember>([["alpha", makeMember("alpha", "developer")]]);

	test("returns [] when there are no live runs", () => {
		const runs: AgentRun[] = [makeRun("alpha", "done"), makeRun("alpha", "error")];
		expect(renderChips(runs, team, 120, stubTheme, 0)).toEqual([]);
	});

	test("returns [] when runs is empty", () => {
		expect(renderChips([], team, 120, stubTheme, 0)).toEqual([]);
	});

	test("renders a single live run with no completion footer when nothing is done", () => {
		const runs: AgentRun[] = [makeRun("alpha", "working", null, "alpha")];
		const lines = renderChips(runs, team, 120, stubTheme, 0);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines).toContain("NANO TEAM");
		// No completion footer when no run is done/error
		expect(lines.join("\n")).not.toContain("completed");
	});

	test("includes a per-name completion footer when runs are done", () => {
		const runs: AgentRun[] = [
			makeRun("alpha", "working", null, "alpha"),
			makeRun("alpha", "done", null, "alpha"),
		];
		const lines = renderChips(runs, team, 120, stubTheme, 0);
		const text = lines.join("\n");
		expect(text).toContain("alpha: 1 completed");
	});
});

describe("renderChips — instance model", () => {
	const team = new Map<string, TeamMember>([["alpha", makeMember("alpha", "developer")]]);

	test("emits one chip per live instanceId (not one per agent name)", () => {
		const runs: AgentRun[] = [
			{ ...makeRun("alpha", "working"), instanceId: "alpha-1" },
			{ ...makeRun("alpha", "working"), instanceId: "alpha-2" },
		];
		const lines = renderChips(runs, team, 200, stubTheme, 0);
		// Two instances produce two sets of border rows (5 lines each + blank).
		// Top border appears once per chip on the same row, but the joined
		// string contains the border character at least twice.
		const borderCount = (lines.join("\n").match(/╭/g) ?? []).length;
		expect(borderCount).toBe(2);
	});

	test("deduplicates repeated instanceIds", () => {
		const runs: AgentRun[] = [
			{ ...makeRun("alpha", "working"), instanceId: "alpha-1" },
			{ ...makeRun("alpha", "working"), instanceId: "alpha-1" },
		];
		const lines = renderChips(runs, team, 200, stubTheme, 0);
		const borderCount = (lines.join("\n").match(/╭/g) ?? []).length;
		expect(borderCount).toBe(1);
	});
});

describe("renderChips — row partitioning", () => {
	const team = (size: number): Map<string, TeamMember> => {
		const m = new Map<string, TeamMember>();
		for (let i = 0; i < size; i++) m.set(`a${i}`, makeMember(`a${i}`));
		return m;
	};

	test("partitions chips into multiple rows when they exceed terminal width", () => {
		const runs: AgentRun[] = Array.from({ length: 6 }, (_, i) =>
			({ ...makeRun(`a${i}`, "working"), instanceId: `a${i}-1` }),
		);
		// 80 cols is narrow enough to wrap 6 chips into at least 2 rows
		const lines = renderChips(runs, team(6), 80, stubTheme, 0);
		const blankRowCount = lines.filter((l) => l === "").length;
		// At least one blank row separator between rows
		expect(blankRowCount).toBeGreaterThan(0);
	});

	test("fits a single chip on one row when terminal is wide", () => {
		const runs: AgentRun[] = [makeRun("a0", "working", null, "a0")];
		const lines = renderChips(runs, team(1), 300, stubTheme, 0);
		// One chip = one row = no blank separators in the chip block
		// (The completion footer, if any, would be separated by a blank line.)
		const chipBlock = lines.slice(0, lines.findIndex((l) => l === "") || lines.length);
		expect(chipBlock.filter((l) => l === "").length).toBe(0);
	});
});

describe("renderChips — state coverage", () => {
	const team = new Map<string, TeamMember>([["alpha", makeMember("alpha", "developer")]]);

	test.each<AgentState>(["thinking", "working"])(
		"renders a chip for live state '%s'",
		(state) => {
			const runs: AgentRun[] = [{ ...makeRun("alpha", state, null, "alpha"), instanceId: "alpha-1" }];
			const lines = renderChips(runs, team, 120, stubTheme, 0);
			expect(lines.length).toBeGreaterThan(0);
		},
	);

	test.each<AgentState>(["idle", "done", "error"])(
		"renders no chips for non-live state '%s' (terminal states go to the completion footer)",
		(state) => {
			const runs: AgentRun[] = [{ ...makeRun("alpha", state, null, "alpha"), instanceId: "alpha-1" }];
			const lines = renderChips(runs, team, 120, stubTheme, 0);
			expect(lines).toEqual([]);
		},
	);
});

describe("renderChips — frame index drives animation", () => {
	const team = new Map<string, TeamMember>([["alpha", makeMember("alpha", "developer")]]);

	test("different frame indices can produce distinct outputs", () => {
		const runs: AgentRun[] = [makeRun("alpha", "thinking", null, "alpha")];
		const outputs = new Set<string>();
		for (let frame = 0; frame < 4; frame++) {
			outputs.add(renderChips(runs, team, 120, stubTheme, frame).join("\n"));
		}
		// At least one face frame is different across the 4 ticks
		expect(outputs.size).toBeGreaterThan(1);
	});
});

describe("renderChips — unknown agent in roster", () => {
	const team = new Map<string, TeamMember>([["alpha", makeMember("alpha", "developer")]]);

	test("falls back to '?' role when the agent is not in the team map", () => {
		const runs: AgentRun[] = [{ ...makeRun("ghost", "working", null, "ghost"), instanceId: "ghost-1" }];
		const lines = renderChips(runs, team, 120, stubTheme, 0);
		// The chip is rendered (not skipped) and contains the role fallback.
		const joined = lines.join("\n");
		expect(joined).toContain("ghost-1");
		expect(joined).toContain("?");
	});

	test("completion footer still includes names not in the current team", () => {
		const runs: AgentRun[] = [
			{ ...makeRun("alpha", "working", null, "alpha"), instanceId: "alpha-1" },
			{ ...makeRun("ghost", "done", null, "ghost"), instanceId: "ghost-1" },
		];
		const lines = renderChips(runs, team, 120, stubTheme, 0);
		expect(lines.join("\n")).toContain("ghost: 1 completed");
	});
});