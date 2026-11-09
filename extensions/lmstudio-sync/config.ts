export type InferenceEngine = "lmstudio" | "omlx";

export interface InferenceEndpoint {
  name?: string;
  baseUrl: string;
  enabled?: boolean;
}

export type LmStudioEndpoint = InferenceEndpoint;
export type EndpointConfig = Record<string, InferenceEndpoint>;

export const DEFAULT_OMLX_ENDPOINTS: EndpointConfig = {
  local: {
    name: "Local oMLX",
    baseUrl: "http://localhost:8000/v1",
  },
};

export function validateEndpointConfig(value: unknown): EndpointConfig {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("expected a non-empty object of endpoint definitions");
  }

  for (const [id, endpoint] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid endpoint ID: ${id}`);
    if (!endpoint || typeof endpoint !== "object" || typeof (endpoint as { baseUrl?: unknown }).baseUrl !== "string") {
      throw new Error(`endpoint ${id} must define a baseUrl`);
    }
    const enabled = (endpoint as { enabled?: unknown }).enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new Error(`endpoint ${id} enabled must be a boolean`);
    }
  }

  return value as EndpointConfig;
}

export function endpointProviderId(endpointId: string, engine: InferenceEngine = "lmstudio"): string {
  return `${endpointId}/${engine}`;
}

export function endpointBaseUrl(endpoint: InferenceEndpoint): string {
  return endpoint.baseUrl.replace(/\/$/, "");
}

export function nativeApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function endpointIdFromProvider(provider: string | undefined, defaultId = "local"): string | undefined {
  if (provider === "lmstudio") return defaultId;
  return provider?.endsWith("/lmstudio") ? provider.slice(0, -"/lmstudio".length) : undefined;
}
