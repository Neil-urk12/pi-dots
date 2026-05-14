export class ModeFileWatcher {
  constructor(
    private readonly modesDir: string,
    private readonly userConfigPath: string,
  ) {}

  async hasChanges(since: number): Promise<boolean> {
    const fs = (await import("fs")).promises;
    const path = await import("path");

    try {
      const st = await fs.stat(this.userConfigPath);
      if (st.mtimeMs > since) return true;
    } catch (_) {}

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
    } catch (_) {}

    return false;
  }
}
