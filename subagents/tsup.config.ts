import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["index.ts"],
	format: ["esm"],
	splitting: false,
	sourcemap: false,
	minify: false,
	dts: false,
	outDir: "dist",
	clean: true,
	external: ["@mariozechner/pi-coding-agent", "@mariozechner/pi-tui"],
});
