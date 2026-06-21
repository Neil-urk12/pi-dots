import type { Clock, TimerHandle } from "./chip-display.ts";

export class NodeClock implements Clock {
	now(): number {
		return Date.now();
	}

	setTimeout(fn: () => void, ms: number): TimerHandle {
		const handle = setTimeout(fn, ms);
		handle.unref?.();
		return {
			cancel: () => {
				clearTimeout(handle);
			},
		};
	}

	setInterval(fn: () => void, ms: number): TimerHandle {
		const handle = setInterval(fn, ms);
		handle.unref?.();
		return {
			cancel: () => {
				clearInterval(handle);
			},
		};
	}
}
