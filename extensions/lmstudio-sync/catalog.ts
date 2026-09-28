import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export interface ModelProfile {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: Record<string, unknown>;
}

export interface EndpointDiscovery {
  available: boolean;
  disabled?: boolean;
  models: ProviderModelConfig[];
  status?: number;
}

const ENDPOINT_TIMEOUT_MS = 5_000;

export function validateProfileConfig(value: unknown): Record<string, Record<string, ModelProfile>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object of endpoint-scoped profiles");
  }
  for (const [endpointId, modelProfiles] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(endpointId)) throw new Error(`invalid profile endpoint ID: ${endpointId}`);
    if (!modelProfiles || typeof modelProfiles !== "object" || Array.isArray(modelProfiles)) {
      throw new Error(`profiles for endpoint ${endpointId} must be an object`);
    }
    for (const [modelId, profile] of Object.entries(modelProfiles)) {
      if (!modelId || !profile || typeof profile !== "object" || Array.isArray(profile)) {
        throw new Error(`profile for ${endpointId}/${modelId} must be an object`);
      }
      const item = profile as Record<string, unknown>;
      if (item.name !== undefined && typeof item.name !== "string") throw new Error(`profile ${modelId} name must be a string`);
      if (item.reasoning !== undefined && typeof item.reasoning !== "boolean") throw new Error(`profile ${modelId} reasoning must be a boolean`);
      if (item.input !== undefined && (!Array.isArray(item.input) || item.input.some((entry) => entry !== "text" && entry !== "image"))) {
        throw new Error(`profile ${modelId} input must contain only text or image`);
      }
      for (const key of ["contextWindow", "maxTokens"] as const) {
        const tokenCount = item[key];
        if (tokenCount !== undefined && (!Number.isSafeInteger(tokenCount) || (tokenCount as number) <= 0)) {
          throw new Error(`profile ${modelId} ${key} must be a positive safe integer`);
        }
      }
      if (item.thinkingLevelMap !== undefined) {
        if (!item.thinkingLevelMap || typeof item.thinkingLevelMap !== "object" || Array.isArray(item.thinkingLevelMap)) {
          throw new Error(`profile ${modelId} thinkingLevelMap must be an object`);
        }
        if (Object.values(item.thinkingLevelMap).some((entry) => entry !== null && typeof entry !== "string")) {
          throw new Error(`profile ${modelId} thinkingLevelMap values must be strings or null`);
        }
      }
      if (item.compat !== undefined && (!item.compat || typeof item.compat !== "object" || Array.isArray(item.compat))) {
        throw new Error(`profile ${modelId} compat must be an object`);
      }
      if (item.cost !== undefined) {
        if (!item.cost || typeof item.cost !== "object" || Array.isArray(item.cost)) throw new Error(`profile ${modelId} cost must be an object`);
        for (const [key, amount] of Object.entries(item.cost)) {
          if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
            throw new Error(`profile ${modelId} cost.${key} must be a non-negative number`);
          }
        }
      }
    }
  }
  return value as Record<string, Record<string, ModelProfile>>;
}
const EMBEDDING_PATTERNS = ["embedding", "embed", "-embed-", "text-embedding", "nomic-embed", "gte-", "e5-"];

function isEmbeddingModel(id: string): boolean {
  const lower = id.toLowerCase();
  return EMBEDDING_PATTERNS.some((pattern) => lower.includes(pattern));
}

function guessReasoning(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.includes("r1") || lower.includes("deepseek-r") || lower.includes("reason") || lower.includes("-r1-");
}

function getParameterCount(id: string): number | null {
  const matches = [...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)b/g)];
  if (matches.length === 0) return null;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) ? value : null;
}

function guessContextWindow(id: string): number {
  const params = getParameterCount(id);
  if (params === null) return 128_000;
  if (params < 5) return 32_000;
  if (params < 20) return 64_000;
  return 128_000;
}

function guessMaxTokens(id: string): number {
  const params = getParameterCount(id);
  if (params === null) return 48_000;
  if (params < 5) return 16_000;
  if (params < 20) return 32_000;
  return 48_000;
}

function formatName(id: string): string {
  const parts = id.split("/");
  const name = parts[parts.length - 1];
  return name.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function buildModel(
  id: string,
  profiles: Record<string, ModelProfile>,
): { model: ProviderModelConfig; source: "profile" | "default" } {
  const defaults: ProviderModelConfig = {
    id,
    name: formatName(id),
    reasoning: guessReasoning(id),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: guessContextWindow(id),
    maxTokens: guessMaxTokens(id),
  };
  const profile = profiles[id];
  if (!profile) return { model: defaults, source: "default" };

  const model: ProviderModelConfig = { ...defaults };
  if (profile.name !== undefined) model.name = profile.name;
  if (profile.reasoning !== undefined) model.reasoning = profile.reasoning;
  if (profile.thinkingLevelMap !== undefined) model.thinkingLevelMap = profile.thinkingLevelMap;
  if (profile.input !== undefined) model.input = profile.input;
  if (profile.contextWindow !== undefined) model.contextWindow = profile.contextWindow;
  if (profile.maxTokens !== undefined) model.maxTokens = profile.maxTokens;
  if (profile.compat !== undefined) model.compat = profile.compat;
  if (profile.cost) model.cost = { ...defaults.cost, ...profile.cost };
  return { model, source: "profile" };
}

export async function discoverEndpoint(
  baseUrl: string,
  profiles: Record<string, ModelProfile>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<EndpointDiscovery> {
  const timeout = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
  const requestSignal = AbortSignal.any(signal ? [signal, timeout] : [timeout]);
  try {
    const response = await fetcher(`${baseUrl}/models`, { signal: requestSignal });
    if (!response.ok) return { available: false, models: [], status: response.status };
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(payload.data)) return { available: false, models: [] };
    const models = payload.data
      .filter((model): model is { id: string } => typeof model.id === "string")
      .filter((model) => !isEmbeddingModel(model.id))
      .map((model) => buildModel(model.id, profiles).model);
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  }
}

export function guessedModelProfile(id: string, supportsImages: boolean): ModelProfile {
  return {
    name: formatName(id),
    reasoning: guessReasoning(id),
    input: supportsImages ? ["text", "image"] : ["text"],
    contextWindow: guessContextWindow(id),
    maxTokens: guessMaxTokens(id),
  };
}
