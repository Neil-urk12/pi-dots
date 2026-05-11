import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────

export type GitState = {
	inRepo: boolean;
	branch?: string;
	dirtyCount: number;
};

export type GitStateHandle = {
	get state(): GitState;
	schedule(): void;
	clear(): void;
	refresh(): Promise<void>;
	onChange(cb: () => void): () => void;
};

// ── Factory ─────────────────────────────────────────────────────

export function createGitState(options: {
	cwd: string;
	debounceMs: number;
	enabled: boolean;
	onChange?: () => void;
}): GitStateHandle {
	let gitState: GitState = { inRepo: false, dirtyCount: 0 };
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	const onChangeListeners: Array<() => void> = [];

	if (options.onChange) onChangeListeners.push(options.onChange);

	async function refresh() {
		if (!options.enabled) {
			gitState = { inRepo: false, dirtyCount: 0 };
			return;
		}

		try {
			const [branchResult, statusResult] = await Promise.all([
				execFileAsync("git", ["branch", "--show-current"], {
					cwd: options.cwd,
					timeout: 2_000,
				}),
				execFileAsync("git", ["status", "--porcelain"], {
					cwd: options.cwd,
					timeout: 2_000,
				}),
			]);

			const branch = branchResult.stdout.trim() || "detached";
			const dirtyCount = statusResult.stdout
				.split("\n")
				.filter(Boolean).length;
			gitState = { inRepo: true, branch, dirtyCount };
		} catch {
			gitState = { inRepo: false, dirtyCount: 0 };
		}

		for (const cb of onChangeListeners) cb();
	}

	function schedule() {
		clearTimer();
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			void refresh();
		}, options.debounceMs);
	}

	function clearTimer() {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = undefined;
		}
	}

	return {
		get state() {
			return gitState;
		},
		schedule,
		clear: clearTimer,
		refresh,
		onChange(cb: () => void) {
			onChangeListeners.push(cb);
			return () => {
				const idx = onChangeListeners.indexOf(cb);
				if (idx >= 0) onChangeListeners.splice(idx, 1);
			};
		},
	};
}
