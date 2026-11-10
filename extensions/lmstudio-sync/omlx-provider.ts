import { createAssistantMessageEventStream, openAICompletionsApi, type OpenAICompletionsOptions } from "@earendil-works/pi-ai/compat";
import type { ApiKeyCredential, AuthResult, Model, Provider, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverEndpoint } from "./catalog.ts";
import type { EndpointDiscovery } from "./catalog.ts";
import { endpointProviderId } from "./config.ts";
import type { InferenceEndpoint } from "./config.ts";
import { omlxBaseUrl, omlxFetch, validOmlxKey } from "./omlx-security.ts";

// Non-secret metadata stored alongside Pi's credential. Changing the URL must
// require a new /login rather than silently sending an old key to another server.
const CREDENTIAL_ENDPOINT = "OMLX_BASE_URL";

export function createOmlxProvider(endpointId: string, endpoint: InferenceEndpoint, fetcher?: typeof fetch) {
  const id = endpointProviderId(endpointId, "omlx");
  const baseUrl = omlxBaseUrl(endpoint.baseUrl);
  const api = openAICompletionsApi();
  let models: Model<"openai-completions">[] = [];
  let generation = 0;

  const credentialMatches = (credential: ApiKeyCredential | undefined) =>
    validOmlxKey(credential?.key) && credential?.env?.[CREDENTIAL_ENDPOINT] === baseUrl;
  const resolveCredential = (credential: ApiKeyCredential | undefined): AuthResult | undefined =>
    credentialMatches(credential)
      ? { auth: { apiKey: credential!.key, baseUrl }, env: { [CREDENTIAL_ENDPOINT]: baseUrl }, source: "stored credential" }
      : undefined;
  const disabled = (): EndpointDiscovery => ({ available: false, disabled: true, models: [] });

  const discover = async (auth: AuthResult | undefined, signal?: AbortSignal): Promise<EndpointDiscovery> => {
    if (endpoint.enabled === false) return disabled();
    if (!validOmlxKey(auth?.auth.apiKey)) return { available: false, models: [], reason: "auth_required" };
    if (auth?.auth.baseUrl !== baseUrl) return { available: false, models: [], reason: "endpoint_changed" };
    const result = await discoverEndpoint(baseUrl, {}, signal, omlxFetch(baseUrl, fetcher ?? fetch), {
      headers: { Authorization: `Bearer ${auth.auth.apiKey}` },
      modelTypes: ["llm", "vlm"],
    });
    if (result.status === 401 || result.status === 403) return { ...result, reason: "auth_rejected" };
    if (result.status && result.status >= 300 && result.status < 400) return { ...result, reason: "redirect_refused" };
    return result;
  };
  const apply = (result: EndpointDiscovery) => {
    models = result.models.map((model) => ({
      ...model,
      api: "openai-completions" as const,
      provider: id,
      baseUrl,
    })) as Model<"openai-completions">[];
  };

  // Delegate the wire protocol and all instrumentation hooks to Pi. Only the
  // transport policy and terminal error text are ours; no raw server exceptions
  // are allowed to become session-visible inference errors.
  const stream = (
    model: Model<"openai-completions">,
    context: TranscriptContext,
    options: SimpleStreamOptions | OpenAICompletionsOptions | undefined,
    simple: boolean,
  ) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (endpoint.enabled === false || model.baseUrl !== baseUrl) throw new Error("blocked");
        const securedOptions = { ...options, fetch: omlxFetch(baseUrl, fetcher ?? fetch) };
        const inner = simple
          ? api.streamSimple(model, context, securedOptions as SimpleStreamOptions)
          : api.stream(model, context, securedOptions as OpenAICompletionsOptions);
        for await (const event of inner) {
          if (event.type === "error") {
            // Partial events share this message object. Sanitize it in place so
            // retained start/update events cannot expose the original exception.
            event.error.errorMessage = event.reason === "aborted"
              ? "oMLX request cancelled"
              : "oMLX inference failed; check authentication, server settings, and connectivity";
            output.push(event);
          } else {
            output.push(event);
          }
        }
      } catch {
        output.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant", content: [], api: "openai-completions", provider: id, model: model.id,
            stopReason: "error", timestamp: Date.now(),
            errorMessage: "oMLX inference failed; check authentication, server settings, and connectivity",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        });
      } finally {
        output.end();
      }
    })();
    return output;
  };

  const provider: Provider<"openai-completions"> = {
    id,
    name: endpoint.name ?? id,
    baseUrl,
    auth: {
      apiKey: {
        name: "oMLX API key",
        async login(interaction) {
          interaction.notify({ type: "info", message: `This key will be used only with ${baseUrl}` });
          const key = await interaction.prompt({ type: "secret", message: "Enter oMLX API key" });
          if (!validOmlxKey(key)) throw new Error("A non-empty oMLX API key without line breaks is required");
          return { type: "api_key", key, env: { [CREDENTIAL_ENDPOINT]: baseUrl } };
        },
        async check({ credential }) {
          return credentialMatches(credential) ? { type: "api_key", source: "stored credential" } : undefined;
        },
        async resolve({ credential }) {
          return resolveCredential(credential);
        },
      },
    },
    getModels: () => models,
    filterModels: (available, credential) => endpoint.enabled !== false && credential?.type === "api_key" && credentialMatches(credential)
      ? available : [],
    async refreshModels(context) {
      if (!context.allowNetwork || context.signal.aborted) return;
      const current = ++generation;
      const auth = context.credential?.type === "api_key" ? resolveCredential(context.credential) : undefined;
      const result = context.baseUrl && context.baseUrl !== baseUrl
        ? { available: false, models: [], reason: "endpoint_changed" as const }
        : await discover(auth, context.signal);
      if (current !== generation || context.signal.aborted) return;
      // Live local catalogs stay in memory. Never persist keys or server payloads.
      await context.publish({ update: () => { if (current === generation) apply(result); } });
    },
    stream: (model, context, options) => stream(model, context, options, false),
    streamSimple: (model, context, options) => stream(model, context, options, true),
  };

  return {
    provider,
    /** Slash commands resolve auth through Pi too; never read auth.json directly. */
    async refresh(registry: Pick<ExtensionContext["modelRegistry"], "getProviderAuth">, signal?: AbortSignal): Promise<EndpointDiscovery> {
      const current = ++generation;
      let result: EndpointDiscovery;
      try {
        // Disabled endpoints neither resolve credentials nor touch the network.
        result = endpoint.enabled === false ? disabled() : await discover(await registry.getProviderAuth(id), signal);
      } catch {
        result = { available: false, models: [], reason: "auth_unavailable" };
      }
      if (current === generation && !signal?.aborted) apply(result);
      return result;
    },
  };
}
