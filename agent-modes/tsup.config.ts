import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/types.ts", "src/mode-catalog.ts", "src/mode-runtime.ts", "src/mode-tool-policy.ts", "src/mode-file-watcher.ts", "src/payload-injection.ts", "src/mode-session-coordinator.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: false,
  minify: false,
  dts: true,
  outDir: "dist",
  clean: true,
});
