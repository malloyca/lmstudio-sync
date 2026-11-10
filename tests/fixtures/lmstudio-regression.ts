// Exercise the actual Pi registry/composer, including its asynchronous cache-only
// refresh after registerProvider. A map-only fake cannot reproduce this race.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Model, Api, Provider } from "@earendil-works/pi-ai";
import extension from "../../extensions/lmstudio-sync/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
const dir = getAgentDir();
await writeFile(join(dir, "lmstudio-profiles.json"), JSON.stringify({
  local: { "qwen3-8b": { name: "LM profile", contextWindow: 65536 } },
}));
const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
  modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
});
const registry = new ModelRegistry(runtime);
const commands = new Map<string, Command>();
const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
let selected: Model<Api> | undefined;
let typedCatalog = false;
let discoveryOffline = false;
const requests: string[] = [];
const predictionRequests: Array<{ url: string; headers: Headers; body: any }> = [];

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(url);
  if (url === "http://localhost:1234/v1/models") {
    assert.ok(!new Headers(init?.headers).has("Authorization"), "oMLX key leaked into LM Studio discovery");
    if (discoveryOffline) throw new Error("offline");
    return Response.json({ data: [
      { id: "qwen3-8b", ...(typedCatalog ? { model_type: "language-model" } : {}) },
      { id: "nomic-embed-text" },
      { id: "qwen3.6-35b-a3b-dflash2" },
      { id: "incoai/Qwen3.8-27B-DFlash2" },
    ] });
  }
  if (url === "http://localhost:8000/v1/models") {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer regression-only-omlx-key");
    return Response.json({ data: [{ id: "qwen3-8b", model_type: "llm" }] });
  }
  if (url === "http://localhost:1234/api/v1/models") {
    return Response.json({ models: [{ key: "qwen3-8b", max_context_length: 131072,
      loaded_instances: [{ id: "qwen3-8b", config: { context_length: 65536 } }] }] });
  }
  if (url.endsWith("/v1/chat/completions")) {
    predictionRequests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response('data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"qwen3-8b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"test","object":"chat.completion.chunk","created":0,"model":"qwen3-8b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
  throw new Error(`Unexpected request (no backend mutations are allowed): ${url}`);
};
let providerChoice: string | undefined = "Local LM Studio";
let choseProvider = false;
const notices: string[] = [];
let pickerCalls = 0;
const ctx = {
  modelRegistry: registry, hasUI: true,
  ui: {
    notify: (text: string) => notices.push(text),
    select: async (title: string, labels: string[]) => {
      pickerCalls++;
      // Simulate time spent in the dialog, allowing Pi's queued refresh to run.
      await nextTick();
      if (title === "Choose a provider") {
        if (choseProvider) return undefined;
        choseProvider = true;
        return labels.find((label) => label.startsWith(providerChoice!));
      }
      if (title.startsWith("Choose a model")) return labels[0];
      throw new Error(`Unexpected profile prompt: ${title}`);
    },
  },
};
const pi = {
  unregisterProvider: (id: string) => registry.unregisterProvider(id),
  registerProvider: (id: string | Provider, config?: any) => {
    if (typeof id === "string") registry.registerProvider(id, config);
    else registry.registerProvider(id);
  },
  registerCommand: (name: string, command: Command) => commands.set(name, command),
  on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  setModel: async (model: Model<Api>) => {
    assert.ok(await runtime.checkAuth(model.provider));
    selected = model;
    for (const handler of handlers.get("model_select") ?? []) await handler({ model, source: "set" }, ctx);
    return true;
  },
} as unknown as ExtensionAPI;
await extension(pi);
await registry.refresh({ allowNetwork: false });
assert.equal(requests.length, 0, "Cache-only initialization must not query local servers");

const pick = async (name: string) => {
  providerChoice = name;
  choseProvider = false;
  selected = undefined;
  await commands.get("set-model-from-provider")!.handler("", ctx as any);
  return selected as Model<Api> | undefined;
};
const lmModel = await pick("Local LM Studio");
assert.equal(lmModel?.provider, "local/lmstudio", "LM Studio models disappeared while the provider picker was open");
assert.equal(lmModel.name, "LM profile");
assert.equal(lmModel.contextWindow, 65536);
assert.equal(pickerCalls, 2);
assert.equal(registry.find("local/lmstudio", "qwen3-8b")?.id, "qwen3-8b");
assert.equal(registry.find("local/lmstudio", "qwen3.6-35b-a3b-dflash2"), undefined);
assert.equal(registry.find("local/lmstudio", "incoai/Qwen3.8-27B-DFlash2"), undefined);

// The /model catalog's network-refresh path uses the same draft exclusion.
await registry.refresh({ allowNetwork: true, providers: ["local/lmstudio"] });
assert.deepEqual(registry.getAll().filter((model) => model.provider === "local/lmstudio").map((model) => model.id), ["qwen3-8b"]);

// Reproduces registration refreshes and auth synchronization from a second engine.
await runtime.login("local/omlx", "api_key", { prompt: async () => "regression-only-omlx-key", notify: () => {} });
const beforeCacheRefresh = requests.length;
await registry.refresh({ allowNetwork: false });
assert.equal(requests.length, beforeCacheRefresh);
assert.equal(registry.find("local/lmstudio", "qwen3-8b")?.name, "LM profile");

// LM Studio inference must retain its own URL, dummy key, and compatibility flags.
const answer = await registry.complete(lmModel, {
  systemPrompt: "Test system message", messages: [{ role: "user", content: "Hello", timestamp: 0 }],
}, { maxTokens: 8, maxRetries: 0 });
assert.equal(answer.stopReason, "stop");
assert.equal(predictionRequests[0].url, "http://localhost:1234/v1/chat/completions");
assert.equal(predictionRequests[0].headers.get("Authorization"), "Bearer lmstudio");
assert.equal(predictionRequests[0].body.model, "qwen3-8b");
assert.equal(predictionRequests[0].body.messages[0].role, "system");
assert.ok(!JSON.stringify(predictionRequests[0].body).includes("regression-only-omlx-key"));

// oMLX-specific metadata must not filter otherwise valid LM Studio models.
typedCatalog = true;
assert.equal((await pick("Local LM Studio"))?.id, "qwen3-8b");
assert.equal((await pick("Local oMLX"))?.provider, "local/omlx");
assert.equal((await pick("Local LM Studio"))?.provider, "local/lmstudio");

// Real network failure clears the old catalog; subsequent recovery restores it.
discoveryOffline = true;
assert.equal(await pick("Local LM Studio"), undefined);
assert.equal(registry.find("local/lmstudio", "qwen3-8b"), undefined);
discoveryOffline = false;
assert.equal((await pick("Local LM Studio"))?.provider, "local/lmstudio");
console.log("LM Studio real-registry regression checks passed");
