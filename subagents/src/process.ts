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
	off?(event: "close", listener: (code: number | null) => void): void;
	off?(event: "error", listener: (error: Error) => void): void;
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

const attachCloseListener = (child: ChildProcess, listener: (code: number | null) => void): void => {
	child.on("close", listener);
};

const attachErrorListener = (child: ChildProcess, listener: (error: Error) => void): void => {
	child.on("error", listener);
};

export class ChildProcessAdapter implements ProcessFactory {
	async start(
		command: string,
		args: readonly string[],
		instructions: string,
		cwd: string,
	): Promise<ProcessHandle> {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "nano-team-"));
		const promptFilePath = path.join(directory, "system.md");
		await fs.promises.writeFile(promptFilePath, instructions, { encoding: "utf-8", mode: 0o600 });

		const child: ChildProcess = spawn(command, [...args, "--append-system-prompt", promptFilePath], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		child.on("close", () => {
			fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
		});

		let killTimer: NodeJS.Timeout | null = null;

		return {
			stdout: child.stdout!,
			stderr: child.stderr!,
			pid: child.pid,
			on(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
				if (event === "close") attachCloseListener(child, listener as (code: number | null) => void);
				else attachErrorListener(child, listener as (error: Error) => void);
			},
			off(event: "close" | "error", listener: ((code: number | null) => void) | ((error: Error) => void)) {
				if (event === "close") child.off("close", listener as (code: number | null) => void);
				else child.off("error", listener as (error: Error) => void);
			},
			kill: () => {
				if (child.killed) return;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, KILL_GRACE_MS);
				killTimer.unref?.();
			},
		};
	}
}
