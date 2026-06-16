import { describe, expect, test } from "bun:test";
import {
	type WidgetFlusher,
	type WidgetFlusherDeps,
	WIDGET_KEY,
	WIDGET_PLACEMENT,
	FLUSH_DEBOUNCE_MS,
	ANIMATION_FRAME_MS,
	createWidgetFlusher,
	formatStatusText,
} from "../flusher.ts";
import { FakeClock, SpyWidgetSink, makeMember, makeRun, stubTheme } from "./helpers.ts";

const buildDeps = (overrides: Partial<WidgetFlusherDeps> = {}) => {
	const clock = new FakeClock();
	const sink = new SpyWidgetSink();
	const flusher = createWidgetFlusher({
		clock,
		sink,
		getRunner: () => ({ list: () => [makeRun("alpha", "working")] }),
		getTeam: () => new Map([["alpha", makeMember("alpha")]]),
		getCols: () => 120,
		theme: stubTheme,
		...overrides,
	});
	return { clock, sink, flusher };
};

describe("WidgetFlusher — tracer bullet", () => {
	test("schedule() debounces then flushes rendered lines to the sink", () => {
		const { clock, sink, flusher } = buildDeps();

		flusher.schedule();
		expect(sink.calls).toHaveLength(0);

		clock.advance(FLUSH_DEBOUNCE_MS);

		expect(sink.calls).toHaveLength(1);
		expect(sink.last?.key).toBe(WIDGET_KEY);
		expect(sink.last?.placement).toBe(WIDGET_PLACEMENT);
		expect(sink.last?.lines).toBeDefined();
		expect(sink.last!.lines!.length).toBeGreaterThan(0);
	});
});

describe("WidgetFlusher — debounce coalescing", () => {
	test("multiple schedule() calls within the window produce one flush", () => {
		const { clock, sink, flusher } = buildDeps();

		flusher.schedule();
		flusher.schedule();
		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS - 1);
		expect(sink.calls).toHaveLength(0);

		clock.advance(1);
		expect(sink.calls).toHaveLength(1);

		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);
	});
});

describe("WidgetFlusher — animation lifecycle", () => {
	test("arms an interval when a live agent is present after flush", () => {
		const { clock, sink, flusher } = buildDeps();

		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		clock.advance(ANIMATION_FRAME_MS);
		expect(sink.calls).toHaveLength(2);

		clock.advance(ANIMATION_FRAME_MS);
		expect(sink.calls).toHaveLength(3);
	});

	test("disarms the interval when no live agent remains", () => {
		const runs = [makeRun("alpha", "working")];
		const { clock, sink, flusher } = buildDeps({
			getRunner: () => ({ list: () => runs }),
		});

		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		runs[0] = makeRun("alpha", "done");

		clock.advance(ANIMATION_FRAME_MS);
		expect(sink.calls).toHaveLength(2);

		clock.advance(ANIMATION_FRAME_MS * 5);
		expect(sink.calls).toHaveLength(2);
	});
});

describe("WidgetFlusher — cancel", () => {
	test("clears both the pending debounce and the animation interval", () => {
		const { clock, sink, flusher } = buildDeps();

		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		flusher.cancel();
		clock.advance(ANIMATION_FRAME_MS * 10);
		expect(sink.calls).toHaveLength(1);
	});

	test("is idempotent — safe to call when nothing is pending", () => {
		const { clock, sink, flusher } = buildDeps();

		expect(() => flusher.cancel()).not.toThrow();
		expect(() => flusher.cancel()).not.toThrow();

		clock.advance(10_000);
		expect(sink.calls).toHaveLength(0);
	});
});

describe("WidgetFlusher — dispose", () => {
	test("clears the widget, cancels pending timers and animation interval", () => {
		const { clock, sink, flusher } = buildDeps();

		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(sink.calls).toHaveLength(1);

		flusher.dispose();
		expect(sink.calls).toHaveLength(2);
		expect(sink.last?.lines).toBeUndefined();

		clock.advance(ANIMATION_FRAME_MS * 10);
		expect(sink.calls).toHaveLength(2);
	});
});

describe("WidgetFlusher — empty output", () => {
	test("writes undefined to the sink when no lines are rendered", () => {
		const { clock, sink, flusher } = buildDeps({
			getRunner: () => ({ list: () => [] }),
		});

		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);

		expect(sink.calls).toHaveLength(1);
		expect(sink.last?.lines).toBeUndefined();
	});
});

describe("WidgetFlusher — runner disappears", () => {
	test("getRunner() returning null stops the animation and writes undefined", () => {
		let runner: { list: () => AgentRun[] } | null = { list: () => [makeRun("alpha", "working")] };
		const { clock, sink, flusher } = buildDeps({
			getRunner: () => runner,
		});

		flusher.schedule();
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

describe("WidgetFlusher — tick escape hatch", () => {
	test("tick(now) flushes immediately, bypassing the debounce", () => {
		const clock = new FakeClock();
		const sink = new SpyWidgetSink();
		const flusher = createWidgetFlusher({
			clock,
			sink,
			getRunner: () => ({ list: () => [makeRun("alpha", "done")] }),
			getTeam: () => new Map([["alpha", makeMember("alpha")]]),
			getCols: () => 120,
			theme: stubTheme,
		});

		flusher.tick(0);
		expect(sink.calls).toHaveLength(1);
		expect(clock.pending()).toBe(0);

		flusher.tick(1000);
		expect(sink.calls).toHaveLength(2);
		expect(clock.pending()).toBe(0);
	});

	test("frame index advances between successive ticks", () => {
		const clock = new FakeClock();
		const sink = new SpyWidgetSink();
		const flusher = createWidgetFlusher({
			clock,
			sink,
			getRunner: () => ({ list: () => [makeRun("alpha", "thinking")] }),
			getTeam: () => new Map([["alpha", makeMember("alpha")]]),
			getCols: () => 120,
			theme: stubTheme,
		});

		for (let frame = 0; frame < 4; frame++) {
			flusher.tick(frame * ANIMATION_FRAME_MS);
		}

		expect(sink.calls).toHaveLength(4);
		const distinctOutputs = new Set(sink.calls.map((c) => c.lines!.join("\n")));
		expect(distinctOutputs.size).toBeGreaterThan(1);
	});
});

describe("formatStatusText", () => {
	const team = (size: number): Map<string, ReturnType<typeof makeMember>> => {
		const m = new Map<string, ReturnType<typeof makeMember>>();
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

describe("WidgetFlusher — setStatus integration", () => {
	const captureStatus = (): { calls: (string | undefined)[]; push: (text: string | undefined) => void } => {
		const calls: (string | undefined)[] = [];
		return { calls, push: (text) => calls.push(text) };
	};

	test("calls setStatus with the live-agent summary on flush", () => {
		const status = captureStatus();
		const { clock, flusher } = buildDeps({ setStatus: status.push });
		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(status.calls).toEqual(["alpha: working"]);
	});

	test("clears the status when no agents are live", () => {
		const status = captureStatus();
		const runs = [makeRun("alpha", "working")];
		const { clock, flusher } = buildDeps({
			setStatus: status.push,
			getRunner: () => ({ list: () => runs }),
		});
		flusher.schedule();
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
		const { clock, flusher } = buildDeps({ setStatus: status.push });
		flusher.schedule();
		clock.advance(FLUSH_DEBOUNCE_MS);
		expect(status.calls[status.calls.length - 1]).toBe("alpha: working");
		flusher.dispose();
		expect(status.calls[status.calls.length - 1]).toBeUndefined();
	});

	test("does not throw when setStatus is omitted", () => {
		const { clock, flusher } = buildDeps();
		flusher.schedule();
		expect(() => clock.advance(FLUSH_DEBOUNCE_MS)).not.toThrow();
	});
});
