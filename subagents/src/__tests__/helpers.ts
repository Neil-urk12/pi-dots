import type { AgentRun, AgentState, TeamMember } from "../types.ts";
import type { Theme } from "@mariozechner/pi-coding-agent";

export class FakeClock {
	private nextId = 1;
	private nextSeq = 0;
	private queue = new Map<number, { fn: () => void; fireAt: number; seq: number }>();
	private time = 0;

	now(): number {
		return this.time;
	}

	setTimeout(fn: () => void, ms: number) {
		const id = this.nextId++;
		const seq = this.nextSeq++;
		this.queue.set(id, { fn, fireAt: this.time + ms, seq });
		return {
			cancel: () => {
				this.queue.delete(id);
			},
		};
	}

	setInterval(fn: () => void, ms: number) {
		const id = this.nextId++;
		const schedule = () => {
			const seq = this.nextSeq++;
			this.queue.set(id, {
				fn: () => {
					fn();
					if (this.queue.has(id)) schedule();
				},
				fireAt: this.time + ms,
				seq,
			});
		};
		schedule();
		return {
			cancel: () => {
				this.queue.delete(id);
			},
		};
	}

	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			let next: { id: number; fn: () => void; fireAt: number; seq: number } | null = null;
			for (const [id, entry] of this.queue) {
				if (entry.fireAt > target) continue;
				if (
					!next ||
					entry.fireAt < next.fireAt ||
					(entry.fireAt === next.fireAt && entry.seq < next.seq)
				) {
					next = { id, ...entry };
				}
			}
			if (!next) break;
			this.time = next.fireAt;
			this.queue.delete(next.id);
			next.fn();
		}
		this.time = target;
	}

	pending(): number {
		return this.queue.size;
	}
}

type SpyCall = Readonly<{
	key: string;
	lines: readonly string[] | undefined;
	placement: string;
}>;

export class SpyWidgetSink {
	readonly calls: SpyCall[] = [];
	setWidget(key: string, lines: readonly string[] | undefined, opts: { placement: string }): void {
		this.calls.push({ key, lines, placement: opts.placement });
	}
	get last(): SpyCall | undefined {
		return this.calls[this.calls.length - 1];
	}
}

export const makeRun = (name: string, state: AgentState): AgentRun => ({
	name,
	instanceId: `${name}-mock`,
	state,
	task: "",
	startedAt: state === "idle" ? 0 : 1000,
	endedAt: state === "done" || state === "error" ? 2000 : null,
	transcript: "",
	activity: null,
	lastError: null,
	pid: null,
});

export const makeMember = (name: string, role = "developer"): TeamMember =>
	Object.freeze({
		name,
		role,
		instructions: "",
		task: "",
		model: "test-model",
		sourceFile: `${name}.yaml`,
	});

export const stubTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;
