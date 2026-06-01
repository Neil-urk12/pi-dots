import { errorMessage, errorCode } from "./types.js";

export class ModeFileWatcher {
  constructor(
    private readonly modesDir: string,
    private readonly userConfigPath: string,
  ) {}

  async hasChanges(since: number): Promise<boolean> {
    const { promises: fs } = await import("fs");
    const path = await import("path");

    try {
      const st = await fs.stat(this.userConfigPath);
      if (st.mtimeMs > since) return true;
    } catch (err: unknown) {
      const code = errorCode(err);
      if (code === "EACCES" || code === "EPERM") {
        console.error(`Permission denied: ${this.userConfigPath}`, err);
      }
    }

    try {
      const files = await fs.readdir(this.modesDir);
      for (const file of files) {
        if (file.endsWith(".md")) {
          try {
            const st = await fs.stat(path.join(this.modesDir, file));
            if (st.mtimeMs > since) return true;
          } catch (err) {
            const code = errorCode(err);
            if (code && code !== "ENOENT") {
              console.error(`[pi-agent-modes] Error statting mode file: ${file}`, err);
            }
          }
        }
      }
    } catch (err: unknown) {
      const code = errorCode(err);
      if (code === "EACCES" || code === "EPERM") {
        console.error(`Permission denied: ${this.modesDir}`, err);
      }
    }

    return false;
  }
}
