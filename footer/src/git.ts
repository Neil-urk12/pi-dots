import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 2_000;

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
	let refreshGeneration = 0;

	if (options.onChange) onChangeListeners.push(options.onChange);

	async function refresh() {
		if (!options.enabled) {
			gitState = { inRepo: false, dirtyCount: 0 };
			return;
		}

		const gen = ++refreshGeneration;
		try {
			const [branchResult, statusResult] = await Promise.all([
				execFileAsync("git", ["branch", "--show-current"], {
					cwd: options.cwd,
					timeout: GIT_TIMEOUT_MS,
				}),
				execFileAsync("git", ["status", "--porcelain"], {
					cwd: options.cwd,
					timeout: GIT_TIMEOUT_MS,
				}),
			]);

			// Discard stale result if a newer refresh was started.
			if (gen !== refreshGeneration) return;

			const branch = branchResult.stdout.trim() || "detached";
			const dirtyCount = statusResult.stdout.split("\n").filter(Boolean).length;
			gitState = { inRepo: true, branch, dirtyCount };
		} catch (err) {
			if (gen !== refreshGeneration) return;
			// Error triage — silence expected failures, log unexpected ones:
			//   ENOENT       → git binary not found (spawn error, string code)
			//   numeric code → git exited non-zero (not a repo, permission denied, etc.)
			//   anything else → unexpected runtime error, log for debugging
			const code = (err as { code?: string | number }).code;
			if (err instanceof Error && code != null && code !== "ENOENT" && typeof code !== "number") {
				console.error("[clean-footer] git refresh failed:", err.message);
			}
			gitState = { inRepo: false, dirtyCount: 0 };
		}

		// Defensive snapshot: callbacks may unsubscribe (splice) during iteration.
		// oxlint-disable-next-line unicorn/no-useless-spread
		for (const cb of [...onChangeListeners]) {
			try {
				cb();
			} catch {
				/* callback must not crash refresh */
			}
		}
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
