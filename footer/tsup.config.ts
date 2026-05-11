import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: false,
  minify: true,
  dts: false,
  outDir: "dist",
  clean: true,
});
