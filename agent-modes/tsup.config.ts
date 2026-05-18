import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/mode-catalog.ts", "src/mode-runtime.ts", "src/mode-tool-policy.ts", "src/mode-file-watcher.ts", "src/payload-injection.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: false,
  minify: true,
  dts: false,
  outDir: "dist",
  clean: true,
});
