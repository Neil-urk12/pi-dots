import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function loadConfig(): GatewayConfig {
  const configPath = join(__dirname, "config.json");
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as GatewayConfig;
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  pi.registerProvider("opengateway", {
    name: "OpenGateway",
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    api: "openai-completions",
    models: config.models,
  });
}
