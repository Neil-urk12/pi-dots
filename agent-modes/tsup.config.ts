import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: false,
  minify: false,
  dts: true,
  outDir: "dist",
  clean: true,
});
