import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  splitting: false,
  sourcemap: false, // Minified prod build; tsconfig.json has sourceMap for dev/type-checking
  minify: true,
  dts: false,
  outDir: "dist",
  clean: true,
});
