import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/index.ts"],
	target: "node22",
	format: ["esm"],
	splitting: false,
	sourcemap: false,
	dts: false,
	minify: true,
	clean: true,
	outDir: "dist",
});
