import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_NAME = "9router";
const DEFAULT_BASE_URL = "http://localhost:20128";
const CONFIG_PATH = join(homedir(), ".pi", "9router.json");

interface NineRouterModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  kind?: string;
}

interface NineRouterConfig {
  baseUrl?: string;
  apiKey?: string;
}

function loadConfig(): NineRouterConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function resolveBaseUrl(config: NineRouterConfig): string {
  return (
    process.env.NINEROUTER_URL ??
    config.baseUrl ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveApiKey(config: NineRouterConfig): string | undefined {
  return process.env.NINEROUTER_KEY ?? config.apiKey;
}

function buildAuthHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

async function fetchModels(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<NineRouterModel[]> {
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: buildAuthHeaders(apiKey),
  });
  if (!res.ok) {
    const hint =
      res.status === 401
        ? "Set NINEROUTER_KEY or add apiKey to ~/.pi/9router.json"
        : `Check NINEROUTER_URL (${baseUrl}) and ensure 9router is running`;
    throw new Error(`9router responded ${res.status}: ${hint}`);
  }
  const data = (await res.json()) as { data?: NineRouterModel[] };
  if (!data.data || !Array.isArray(data.data)) {
    throw new Error("9router response missing 'data' array");
  }
  return data.data;
}

function isChatModel(m: NineRouterModel): boolean {
  // No `kind` field = chat model (per 9router skill example).
  // `kind: "chat"` is also a chat model.
  return !m.kind || m.kind === "chat";
}

function getNineRouterModelContextWindow(modelId: string): number {
  const id = modelId.toLowerCase();
  const baseId = id.split("/").pop() ?? id;

  // 1. Gemini models:
  // gemini-3.1-pro-preview -> 2M
  if (baseId.includes("gemini-3.1-pro") || baseId.includes("gemini-3-pro") || baseId.includes("gemini-pro")) {
    return 2_000_000;
  }
  // gemini-3.5-flash, gemini-3.1-flash, gemini-3-flash, etc. -> 1M
  if (baseId.includes("gemini-")) {
    return 1_000_000;
  }

  // 2. Claude models:
  // claude-opus, claude-sonnet, claude-haiku -> 200k
  if (baseId.includes("claude-")) {
    return 200_000;
  }

  // 3. GLM (Zhipu) models:
  // GLM-5, GLM-5.1, GLM-5.2 -> 1M
  if (baseId.includes("glm-5")) {
    return 1_000_000;
  }

  // 4. Kimi models:
  // kimi-k2.7-code, kimi-k2.6, kimi-k2.5, etc. -> 1M
  if (baseId.includes("kimi-k2") || baseId.includes("kimi-for-coding")) {
    return 1_000_000;
  }

  // 5. MiniMax models:
  // minimax-m3, MiniMax-M3, MiniMax-M2.7 -> 1M
  if (baseId.includes("minimax-m3") || baseId.includes("minimax-m2.7")) {
    return 1_000_000;
  }

  // 6. Qwen models:
  // qwen3.6-plus, qwen3.6-flash, qwen3.7-max, qwen3-max -> 1M
  if (
    baseId.includes("qwen3.6-plus") ||
    baseId.includes("qwen3.6-flash") ||
    baseId.includes("qwen3.7-max") ||
    baseId.includes("qwen3-max")
  ) {
    return 1_000_000;
  }

  // 7. Nemotron models:
  // nemotron-3-ultra -> 1M
  if (baseId.includes("nemotron-3-ultra")) {
    return 1_000_000;
  }

  // 8. DeepSeek Flash & Xiaomi Mimo:
  // deepseek-v4-flash, mimo-v2.5, north-mini-code -> 256k
  if (
    baseId.includes("deepseek-v4-flash") ||
    baseId.includes("mimo-v2.5") ||
    baseId.includes("mimo-v2-flash") ||
    baseId.includes("mimo-v2-omni") ||
    baseId.includes("mimo-v2-pro") ||
    baseId.includes("north-mini-code")
  ) {
    return 256_000;
  }

  // Default fallback for other models
  return 128_000;
}

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  const baseUrl = resolveBaseUrl(config);
  const apiKey = resolveApiKey(config);

  let rawModels: NineRouterModel[];
  try {
    rawModels = await fetchModels(baseUrl, apiKey);
  } catch (err) {
    console.error(
      `[pi-9router] Failed to fetch models from ${baseUrl}/v1/models:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const chatModels = rawModels.filter(isChatModel);
  if (chatModels.length === 0) {
    const detail =
      rawModels.length === 0
        ? "Gateway returned an empty model list."
        : `Got ${rawModels.length} model(s) but all had non-chat 'kind' values.`;
    console.error(
      `[pi-9router] No chat-capable models at ${baseUrl}/v1/models. ${detail}`,
    );
    return;
  }

  pi.registerProvider(PROVIDER_NAME, {
    name: "9Router",
    baseUrl: `${baseUrl}/v1`,
    // pi's `registerProvider` validator rejects `apiKey: undefined` AND `apiKey: ""`
    // (model-registry.js:679: `if (!config.apiKey && !config.oauth) throw`).
    // `resolveApiKey` falls through an unset env var to the config file, which may
    // hold an empty string. Use `||` (not `??`) so both cases land on the placeholder.
    // 9Router with `requireApiKey=false` (the default) accepts any non-empty Bearer
    // and ignores it; for auth-enabled 9Router, set NINEROUTER_KEY.
    apiKey: apiKey || "no-auth",
    api: "openai-completions",
    models: chatModels.map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: true,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: getNineRouterModelContextWindow(m.id),
      maxTokens: 8_192,
    })),
  });
}
