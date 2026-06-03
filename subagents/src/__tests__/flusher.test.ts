import { describe, expect, test } from "bun:test";
import {
	type WidgetFlusher,
	type WidgetFlusherDeps,
	WIDGET_KEY,
	WIDGET_PLACEMENT,
	FLUSH_DEBOUNCE_MS,
	ANIMATION_FRAME_MS,
	createWidgetFlusher,
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
