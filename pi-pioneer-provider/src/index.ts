import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "pioneer";
const BASE_URL = "https://api.pioneer.ai/v1";
const MODELS_ENDPOINT = `${BASE_URL}/models`;

interface PioneerModel {
  id: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  attachments?: boolean;
}

async function fetchModels(apiKey: string): Promise<PioneerModel[]> {
  const res = await fetch(MODELS_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  const data = await res.json();
  return data.data ?? data;
}

function resolveApiKey(): string | undefined {
  if (process.env.PIONEER_API_KEY) return process.env.PIONEER_API_KEY;
  try {
    const configPath = join(homedir(), ".config", "pi-pioneer", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return config.apiKey;
  } catch {
    return undefined;
  }
}

export default async function (pi: ExtensionAPI) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      "[pi-pioneer] No API key found. Set PIONEER_API_KEY or create ~/.config/pi-pioneer/config.json with { \"apiKey\": \"...\" }",
    );
    return;
  }

  let pioneerModels: PioneerModel[];
  try {
    pioneerModels = await fetchModels(apiKey);
  } catch (err) {
    console.error("[pi-pioneer] Failed to fetch models:", err);
    return;
  }

  pi.registerProvider(PROVIDER_NAME, {
    name: "Pioneer AI",
    baseUrl: BASE_URL,
    apiKey,
    api: "openai-completions",
    models: pioneerModels.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning ?? true,
      input: m.attachments ? (["text", "image"] as const) : (["text"] as const),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.context_window ?? 128_000,
      maxTokens: m.max_tokens ?? 8_192,
    })),
  });
}