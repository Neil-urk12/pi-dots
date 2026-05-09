import { registerTool } from "@mariozechner/pi-coding-agent";

registerTool({
	name: "web_search",
	description: "Search the web for information",
	parameters: {
		query: { type: "string", description: "Search query" },
	},
	async execute(args) {
		// Use pi's built-in web_search via spawn
		const { spawn } = await import("node:child_process");
		return new Promise((resolve) => {
			const proc = spawn("pi", [
				"--mode",
				"json",
				"web_search",
				JSON.stringify(args),
			]);
			let out = "";
			proc.stdout.on("data", (d) => (out += d.toString()));
			proc.on("close", () => resolve(out));
		});
	},
});
