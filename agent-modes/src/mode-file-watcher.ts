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
    } catch (err: any) {
      if (err?.code === "EACCES" || err?.code === "EPERM") {
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
          } catch (_) {}
        }
      }
    } catch (err: any) {
      if (err?.code === "EACCES" || err?.code === "EPERM") {
        console.error(`Permission denied: ${this.modesDir}`, err);
      }
    }

    return false;
  }
}
