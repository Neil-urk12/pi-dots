import { readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  models: Array<{
    id: string;
    name: string;
    reasoning: boolean;
    input: string[];
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    contextWindow: number;
    maxTokens: number;
  }>;
}

function loadConfig(): GatewayConfig | null {
  const paths = [
    join(os.homedir(), ".pi", "agent", "opengateway.json"),
    join(process.cwd(), ".pi", "opengateway.json"),
  ];

  for (const configPath of paths) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      return JSON.parse(raw) as GatewayConfig;
    } catch {
      // try next path
    }
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  if (!config) {
    pi.registerCommand("opengateway", {
      description: "Show OpenGateway config status",
      handler: async () => {
        return `No config found. Create one at:\n  ~/.pi/agent/opengateway.json  (global)\n  .pi/opengateway.json          (project)\n\nSee config.example.json for the required shape.`;
      },
    });
    return;
  }

  pi.registerProvider("opengateway", {
    name: "OpenGateway",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: "openai-completions",
    models: config.models,
  });
}
