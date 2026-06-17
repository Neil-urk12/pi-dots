import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";

export type ProcessHandle = Readonly<{
	stdout: Readable;
	stderr: Readable;
	pid: number | undefined;
	on(event: "close", listener: (code: number | null) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	kill(): void;
}>;

export type ProcessFactory = Readonly<{
	start(
		command: string,
		args: readonly string[],
		instructions: string,
		cwd: string,
	): Promise<ProcessHandle>;
}>;

const KILL_GRACE_MS = 2000;

export class ChildProcessAdapter implements ProcessFactory {
	async start(
		command: string,
		args: readonly string[],
		instructions: string,
		cwd: string,
	): Promise<ProcessHandle> {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nano-team-"));
		const promptFilePath = path.join(directory, "system.md");
		await fs.promises.writeFile(promptFilePath, instructions, {
			encoding: "utf-8",
			mode: 0o600,
		});

		const child: ChildProcess = spawn(
			command,
			[...args, "--append-system-prompt", promptFilePath],
			{
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// detached: true on POSIX makes the child the leader of a
				// new process group, so process.kill(-pid, ...) targets
				// the child + its descendants (not the parent). Required
				// for the sendSignal group-kill pattern below to work.
				detached: process.platform !== "win32",
			},
		);

		// Buffer 'error' events so a consumer that registers a listener
		// AFTER start() (the common case — subagent.ts attaches its listener
		// in the await new Promise(...) block) still receives them. Without
		// this, an early 'error' (e.g. spawn ENOENT) becomes an unhandled
		// exception on the underlying ChildProcess and crashes the host.
		const errorBuffer: Error[] = [];
		const errorListeners: Array<(error: Error) => void> = [];
		child.on("error", (error) => {
			if (errorListeners.length > 0) {
				for (const fn of errorListeners) fn(error);
			} else {
				errorBuffer.push(error);
			}
		});

		let killTimer: NodeJS.Timeout | null = null;

		// Send a signal to the child. On POSIX, deliver to the entire
		// process group (negative pid) so the signal also reaches
		// grandchildren — e.g. when the spawned `bun` runs a script,
		// `child.kill("SIGTERM")` alone only hits `bun`, not the script.
		// Falls back to `child.kill` if the group kill fails.
		const sendSignal = (signal: NodeJS.Signals): void => {
			if (process.platform !== "win32" && child.pid) {
				try {
					process.kill(-child.pid, signal);
					return;
				} catch {
					// Fall through to direct kill.
				}
			}
			child.kill(signal);
		};

		child.on("close", () => {
			// Clear the SIGKILL grace timer so it doesn't keep a reference
			// to the process after a clean exit.
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = null;
			}
			// Best-effort cleanup; failures are non-actionable (perm errors,
			// EBUSY on Windows) and the OS reclaims /tmp entries eventually.
			fs.promises
				.rm(directory, { recursive: true, force: true })
				.catch(() => {});
		});

		const on = (
			event: "close" | "error",
			listener: ((code: number | null) => void) | ((error: Error) => void),
		): void => {
			if (event === "close") {
				child.on("close", listener as (code: number | null) => void);
			} else {
				const errListener = listener as (error: Error) => void;
				errorListeners.push(errListener);
				// Flush any error that fired before this listener was registered.
				while (errorBuffer.length > 0) {
					const buffered = errorBuffer.shift()!;
					errListener(buffered);
				}
			}
		};

		return {
			// stdio: ["ignore", "pipe", "pipe"] guarantees these are non-null.
			stdout: child.stdout!,
			stderr: child.stderr!,
			pid: child.pid,
			on,
			kill: () => {
				if (child.killed) return;
				sendSignal("SIGTERM");
				killTimer = setTimeout(() => {
					if (child.killed) return;
					sendSignal("SIGKILL");
				}, KILL_GRACE_MS);
				killTimer.unref();
			},
		};
	}
}
