import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "tokenrouter";
const BASE_URL = "https://api.tokenrouter.com/v1";

interface TokenRouterModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

interface TokenRouterConfig {
  apiKey?: string;
  models?: TokenRouterModel[];
}

const DEFAULT_MODELS: TokenRouterModel[] = [
  { id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 1_000_000 },
];

function loadConfig(): TokenRouterConfig {
  try {
    const configPath = join(homedir(), ".pi", "tokenrouter.json");
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function resolveApiKey(config: TokenRouterConfig): string | undefined {
  if (process.env.TOKENROUTER_API_KEY) return process.env.TOKENROUTER_API_KEY;
  return config.apiKey;
}

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  const apiKey = resolveApiKey(config);

  if (!apiKey) {
    console.error(
      "[pi-tokenrouter] No API key found. Set TOKENROUTER_API_KEY or add \"apiKey\" to ~/.pi/tokenrouter.json",
    );
    return;
  }

  const models = config.models ?? DEFAULT_MODELS;

  pi.registerProvider(PROVIDER_NAME, {
    name: "TokenRouter",
    baseUrl: BASE_URL,
    apiKey,
    api: "openai-completions",
    models: models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: true,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 8_192,
    })),
  });
}
