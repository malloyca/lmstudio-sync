// Run in a child process with an isolated HOME so no real Pi state is touched.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createModels, InMemoryCredentialStore, type Provider } from "@earendil-works/pi-ai";
import extension from "../../extensions/lmstudio-sync/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Handler = (event: any, ctx: any) => unknown;
const providers = new Map<string, ProviderConfig>();
const nativeProviders = new Map<string, Provider>();
const runtime = createModels({ credentials: new InMemoryCredentialStore() });
const commands = new Map<string, Command>();
const handlers = new Map<string, Handler[]>();
let selected: { provider: string; id: string } | undefined;
const pi = {
  unregisterProvider: () => {},
  registerProvider: (id: string | Provider, config?: ProviderConfig) => {
    if (typeof id === "string") providers.set(id, config!);
    else { nativeProviders.set(id.id, id); runtime.setProvider(id); }
  },
  registerCommand: (name: string, command: Command) => commands.set(name, command),
  on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  setModel: async (model: { provider: string; id: string }) => { selected = model; return true; },
} as unknown as ExtensionAPI;
const dir = join(homedir(), ".pi", "agent");
await writeFile(join(dir, "lmstudio-profiles.json"), JSON.stringify({
  local: { "qwen3-8b": { name: "LM-only profile", contextWindow: 12345 } },
}));
await extension(pi);
assert.deepEqual([...providers.keys(), ...nativeProviders.keys()].sort(), ["local/lmstudio", "local/omlx"]);
assert.equal(nativeProviders.get("local/omlx")?.name, "Local oMLX");
assert.equal(nativeProviders.get("local/omlx")?.baseUrl, "http://localhost:8000/v1");
assert.ok(nativeProviders.get("local/omlx")!.auth.apiKey?.login);
for (const name of ["omlx-endpoints", "omlx-toggle-endpoint", "lmstudio-endpoints", "lmstudio-toggle-endpoint"]) {
  assert.ok(commands.has(name));
}

const requests: string[] = [];
let omlxOffline = false;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  requests.push(url);
  assert.ok(url.endsWith("/v1/models"), `Unexpected native API request: ${url}`);
  if (url.includes(":8000/")) {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-only-key");
    assert.equal(init?.redirect, "manual");
  }
  if (omlxOffline && url.includes(":8000/")) throw new Error("offline");
  return Response.json({ data: [{ id: "qwen3-8b", model_type: "llm" }] });
};
await runtime.login("local/omlx", "api_key", { prompt: async () => "fixture-only-key", notify: () => {} });
await runtime.refresh({ providers: ["local/omlx"] });
const refreshed = nativeProviders.get("local/omlx")!.getModels();
assert.equal(refreshed![0].name, "Qwen3 8b");
assert.notEqual((refreshed![0] as { contextWindow: number }).contextWindow, 12345);
assert.deepEqual(requests, ["http://localhost:8000/v1/models"]);

const allModels = () => [
  ...[...providers].flatMap(([provider, config]) => (config.models ?? []).map((model) => ({ ...model, provider }))),
  ...[...nativeProviders.values()].flatMap((provider) => provider.getModels()),
];
const pickerLabels: string[][] = [];
const ctx = {
  hasUI: true,
  ui: {
    select: async (_title: string, labels: string[]) => {
      pickerLabels.push(labels);
      if (pickerLabels.length === 1) return labels.find((label) => label.startsWith("Local oMLX"));
      if (pickerLabels.length === 2) return labels[0];
      return undefined;
    },
    notify: () => {},
  },
  modelRegistry: { getAll: allModels, getProviderAuth: (id: string) => runtime.getAuth(id) },
};
await commands.get("set-model-from-provider")!.handler("", ctx as any);
assert.deepEqual(selected && { provider: selected.provider, id: selected.id }, {
  provider: "local/omlx", id: "qwen3-8b",
});
assert.equal(pickerLabels[0].filter((label) => label.startsWith("Local oMLX")).length, 1);
assert.ok(pickerLabels[0].includes("Local LM Studio — 1 models"));

// Selecting/restoring oMLX must never prompt for an LM profile or call its native APIs.
const before = requests.length;
const omlxContext = { ...ctx, model: selected };
for (const handler of handlers.get("session_start") ?? []) await handler({}, omlxContext);
for (const handler of handlers.get("model_select") ?? []) await handler({ model: selected, source: "set" }, omlxContext);
assert.equal(requests.length, before);
assert.equal(pickerLabels.length, 2);

// The explicit sync command refreshes and reports both engines.
let syncLines: string[] = [];
await commands.get("sync-models")!.handler("", {
  modelRegistry: ctx.modelRegistry,
  ui: {
    custom: async (factory: any) => {
      const component = factory({}, { fg: (_color: string, text: string) => text }, {}, () => {});
      syncLines = component.render(120);
    },
  },
} as any);
assert.ok(syncLines.some((line) => line.includes("Local oMLX: 1 models")));
assert.ok(syncLines.some((line) => line.includes("Local LM Studio: 1 models")));

// Offline endpoints remain visible, without a stale model catalog.
omlxOffline = true;
await commands.get("set-model-from-provider")!.handler("", ctx as any);
assert.ok(pickerLabels.at(-1)!.includes("Local oMLX — offline"));
assert.deepEqual(nativeProviders.get("local/omlx")!.getModels(), []);

// Toggle writes only the oMLX file, then reloads. Disabled endpoints are not probed.
const lmSettings = await readFile(join(dir, "lmstudio-endpoints.json"), "utf8");
let reloads = 0;
await commands.get("omlx-toggle-endpoint")!.handler("", {
  ui: { select: async (_title: string, labels: string[]) => labels[0], notify: () => {} },
  reload: async () => { reloads++; },
} as any);
assert.equal(reloads, 1);
assert.equal(JSON.parse(await readFile(join(dir, "omlx-endpoints.json"), "utf8")).local.enabled, false);
assert.equal(await readFile(join(dir, "lmstudio-endpoints.json"), "utf8"), lmSettings);
await extension(pi);
requests.length = 0;
await runtime.refresh({ providers: ["local/omlx"] });
assert.deepEqual(nativeProviders.get("local/omlx")!.getModels(), []);
assert.deepEqual(requests, []);

// Invalid edits do not overwrite saved settings.
const saved = await readFile(join(dir, "omlx-endpoints.json"), "utf8");
await commands.get("omlx-endpoints")!.handler("", {
  ui: { editor: async () => '{"local":{}}', notify: () => {} },
  reload: async () => { throw new Error("must not reload invalid configuration"); },
} as any);
assert.equal(await readFile(join(dir, "omlx-endpoints.json"), "utf8"), saved);
console.log("oMLX integration checks passed");
