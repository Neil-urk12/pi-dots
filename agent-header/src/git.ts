import { execFile } from "node:child_process";

export type GitState = {
	branch?: string;
};

export type GitStateHandle = {
	state: GitState;
	refresh(): Promise<void>;
	schedule(): void;
	clear(): void;
};

const DEFAULT_DEBOUNCE_MS = 500;

export function createGitState(opts: {
	cwd: string;
	debounceMs?: number;
	enabled?: boolean;
	onChange: () => void;
}): GitStateHandle {
	const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	let enabled = opts.enabled ?? true;
	let state: GitState = {};
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	async function refresh(): Promise<void> {
		if (!enabled || disposed) return;

		try {
			const branch = await getGitBranch(opts.cwd);
			if (branch !== state.branch) {
				state = { branch };
				opts.onChange();
			}
		} catch {
			// Git not available or not a git repo
			if (state.branch !== undefined) {
				state = {};
				opts.onChange();
			}
		}
	}

	function schedule(): void {
		if (!enabled || disposed) return;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			void refresh();
		}, debounceMs);
	}

	function clear(): void {
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
		state = {};
		disposed = true;
	}

	// Initial refresh
	void refresh();

	return {
		get state() {
			return state;
		},
		refresh,
		schedule,
		clear,
	};
}

function getGitBranch(cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["branch", "--show-current"], { cwd, timeout: 2000 }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			const branch = stdout.trim();
			if (branch) {
				resolve(branch);
			} else {
				// Detached HEAD or empty
				execFile("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 2000 }, (err, out) => {
					if (err) {
						reject(err);
						return;
					}
					resolve(`HEAD@${out.trim()}`);
				});
			}
		});
	});
}
