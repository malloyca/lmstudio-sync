export interface LmStudioEndpoint {
  name?: string;
  baseUrl: string;
  enabled?: boolean;
}

export type EndpointConfig = Record<string, LmStudioEndpoint>;

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

export function endpointProviderId(endpointId: string): string {
  return `${endpointId}/lmstudio`;
}

export function endpointBaseUrl(endpoint: LmStudioEndpoint): string {
  return endpoint.baseUrl.replace(/\/$/, "");
}

export function nativeApiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function endpointIdFromProvider(provider: string | undefined, defaultId = "local"): string | undefined {
  if (provider === "lmstudio") return defaultId;
  return provider?.endsWith("/lmstudio") ? provider.slice(0, -"/lmstudio".length) : undefined;
}
