import { validateEndpointConfig } from "./config.ts";
import type { EndpointConfig } from "./config.ts";

/** Never include the supplied URL in errors: it might contain credentials. */
export function omlxBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("oMLX requires a valid HTTP(S) base URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("oMLX URLs must not contain credentials, query parameters, or fragments");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("oMLX requires HTTPS except on loopback; use a local tunnel for remote HTTP servers");
  }
  return url.href.replace(/\/+$/, "");
}

export function validateOmlxEndpointConfig(value: unknown): EndpointConfig {
  let endpoints: EndpointConfig;
  try {
    endpoints = validateEndpointConfig(value);
  } catch {
    throw new Error("Invalid oMLX endpoint definitions (expected endpoint IDs, baseUrl, and optional enabled)");
  }
  for (const endpoint of Object.values(endpoints)) {
    if (Object.keys(endpoint).some((key) => !["name", "baseUrl", "enabled"].includes(key))) {
      throw new Error("oMLX endpoints accept only name, baseUrl, and enabled; store keys using /login");
    }
    if (endpoint.name !== undefined && typeof endpoint.name !== "string") {
      throw new Error("oMLX endpoint names must be strings");
    }
    omlxBaseUrl(endpoint.baseUrl);
  }
  return endpoints;
}

export function validOmlxKey(key: string | undefined): key is string {
  return typeof key === "string" && key.trim().length > 0 && !/[\r\n]/.test(key);
}

/** Restrict both discovery and inference to the configured endpoint, never follow
 * redirects, and discard server-controlled error text and transport exceptions. */
export function omlxFetch(baseUrl: string, fetcher: typeof fetch = fetch): typeof fetch {
  const allowed = new Set([`${baseUrl}/models`, `${baseUrl}/chat/completions`]);
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!allowed.has(url)) throw new Error("oMLX request blocked: endpoint does not match configured URL");
    let response: Response;
    try {
      response = await fetcher(input, { ...init, redirect: "manual" });
    } catch {
      throw new Error("oMLX connection failed or request cancelled");
    }
    if (response.ok && !response.redirected) return response;
    await response.body?.cancel().catch(() => {});
    const status = response.redirected ? 502 : response.status;
    const message = status === 401 || status === 403
      ? "oMLX authentication rejected; sign in again using /login"
      : status >= 300 && status < 400
        ? "oMLX redirect refused; configure the final server URL and sign in again"
        : `oMLX request failed (HTTP ${status})`;
    return Response.json({ error: { message } }, { status });
  };
}
