import assert from "node:assert/strict";
import test from "node:test";
import {
  endpointBaseUrl,
  endpointIdFromProvider,
  endpointProviderId,
  validateEndpointConfig,
} from "../extensions/lmstudio-sync/config.ts";
import { buildModel, discoverEndpoint, validateProfileConfig } from "../extensions/lmstudio-sync/catalog.ts";

test("endpoint config accepts optional enabled and rejects malformed definitions", () => {
  assert.deepEqual(validateEndpointConfig({
    local: { name: "Local", baseUrl: "http://localhost:1234/v1" },
    remote_2: { baseUrl: "http://example.test/v1", enabled: false },
  }), {
    local: { name: "Local", baseUrl: "http://localhost:1234/v1" },
    remote_2: { baseUrl: "http://example.test/v1", enabled: false },
  });
  assert.throws(() => validateEndpointConfig(null), /non-empty object/);
  assert.throws(() => validateEndpointConfig({ "bad/id": { baseUrl: "http://x" } }), /invalid endpoint ID/);
  assert.throws(() => validateEndpointConfig({ local: {} }), /must define a baseUrl/);
  assert.throws(() => validateEndpointConfig({ local: { baseUrl: "http://x", enabled: "yes" } }), /enabled must be a boolean/);
});

test("profile validation enforces endpoint scope and supported field types", () => {
  const valid = validateProfileConfig({
    local: { "qwen3.8-27b": { contextWindow: 65536, input: ["text", "image"], cost: { input: 0.1 } } },
    m3max: { "qwen3.8-27b": { contextWindow: 131072 } },
  });
  assert.equal(valid.local["qwen3.8-27b"].contextWindow, 65536);
  assert.throws(() => validateProfileConfig([]), /endpoint-scoped profiles/);
  assert.throws(() => validateProfileConfig({ "bad/id": {} }), /invalid profile endpoint ID/);
  assert.throws(() => validateProfileConfig({ local: { model: { contextWindow: 0 } } }), /positive safe integer/);
  assert.throws(() => validateProfileConfig({ local: { model: { input: ["audio"] } } }), /text or image/);
  assert.throws(() => validateProfileConfig({ local: { model: { reasoning: "yes" } } }), /reasoning must be a boolean/);
  assert.throws(() => validateProfileConfig({ local: { model: { thinkingLevelMap: { high: 3 } } } }), /values must be strings or null/);
});

test("endpoint naming and URL helpers retain provider scoping", () => {
  assert.equal(endpointProviderId("m3max"), "m3max/lmstudio");
  assert.equal(endpointIdFromProvider("lmstudio"), "local");
  assert.equal(endpointIdFromProvider("m3max/lmstudio"), "m3max");
  assert.equal(endpointIdFromProvider("openai"), undefined);
  assert.equal(endpointBaseUrl({ baseUrl: "http://localhost:1234/v1/" }), "http://localhost:1234/v1");
});

test("discovery filters embeddings and uses only the selected endpoint's profile", async () => {
  const profiles = {
    local: { "qwen3.8-27b": { contextWindow: 65536, name: "Local profile" } },
    m3max: { "qwen3.8-27b": { contextWindow: 131072, name: "M3 profile" } },
  };
  const result = await discoverEndpoint(
    "http://m3.test/v1",
    profiles.m3max,
    undefined,
    async (input) => {
      assert.equal(String(input), "http://m3.test/v1/models");
      return Response.json({ data: [
        { id: "qwen3.8-27b" },
        { id: "nomic-embed-text" },
        { id: 12 },
      ] });
    },
  );
  assert.equal(result.available, true);
  assert.deepEqual(result.models.map((model) => model.id), ["qwen3.8-27b"]);
  assert.equal(result.models[0].contextWindow, 131072);
  assert.equal(result.models[0].name, "M3 profile");

  const local = buildModel("qwen3.8-27b", profiles.local);
  assert.equal(local.model.contextWindow, 65536);
  assert.equal(local.model.name, "Local profile");
});

test("discovery reports offline, HTTP-error, and malformed responses as unavailable", async () => {
  const offline = await discoverEndpoint("http://offline/v1", {}, undefined, async () => {
    throw new Error("offline");
  });
  assert.deepEqual(offline, { available: false, models: [] });

  const httpError = await discoverEndpoint("http://bad/v1", {}, undefined, async () =>
    new Response("unavailable", { status: 503 }),
  );
  assert.deepEqual(httpError, { available: false, models: [], status: 503 });

  const malformed = await discoverEndpoint("http://bad-json/v1", {}, undefined, async () =>
    Response.json({ items: [] }),
  );
  assert.deepEqual(malformed, { available: false, models: [] });
});

test("oMLX discovery keeps chat aliases and excludes explicit non-chat model types", async () => {
  const result = await discoverEndpoint("http://localhost:8000/v1", {}, undefined, async (input) => {
    assert.equal(String(input), "http://localhost:8000/v1/models");
    return Response.json({ data: [
      { id: "qwen3-8b", model_type: "llm" },
      { id: "qwen3-8b:thinking", model_type: "llm" },
      { id: "vision", model_type: "vlm" },
      { id: "custom-vector-alias", model_type: "embedding" },
      { id: "custom-ranking-alias", model_type: "reranker" },
      { id: "document-converter", model_type: "markitdown" },
      { id: "older-server-model" },
      { id: "another-older-model", model_type: null },
      null,
    ] });
  }, { modelTypes: ["llm", "vlm"] });
  assert.equal(result.available, true);
  assert.deepEqual(result.models.map((model) => model.id), [
    "qwen3-8b", "qwen3-8b:thinking", "vision", "older-server-model", "another-older-model",
  ]);
});

test("shared discovery excludes DFlash2 draft IDs regardless of engine or case", async () => {
  const fetcher: typeof fetch = async () => Response.json({ data: [
    { id: "qwen3.6-35b-a3b-dflash2" },
    { id: "incoai/Qwen3.8-27B-DFlash2" },
    { id: "DFLASH2-draft" },
    { id: "zai-org/glm-4.7-flash" },
    { id: "qwen/qwen3.8-27b" },
    { id: "nomic-embed-text" },
  ] });
  const result = await discoverEndpoint("http://localhost:1234/v1", {
    "qwen3.6-35b-a3b-dflash2": { name: "Custom profile cannot make a draft usable" },
    "qwen/qwen3.8-27b": { name: "My Qwen", contextWindow: 65536 },
  }, undefined, fetcher);
  assert.equal(result.available, true);
  assert.deepEqual(result.models.map((model) => model.id), ["zai-org/glm-4.7-flash", "qwen/qwen3.8-27b"]);
  assert.equal(result.models[1].name, "My Qwen");
  assert.equal(result.models[1].contextWindow, 65536);

  const omlx = await discoverEndpoint("http://localhost:8000/v1", {}, undefined, fetcher, { modelTypes: ["llm", "vlm"] });
  assert.deepEqual(omlx.models.map((model) => model.id), ["zai-org/glm-4.7-flash", "qwen/qwen3.8-27b"]);
});

test("shared discovery allows an empty catalog when only draft models are present", async () => {
  const result = await discoverEndpoint("http://localhost:1234/v1", {}, undefined,
    async () => Response.json({ data: [{ id: "only-dflash2-draft" }] }));
  assert.deepEqual(result, { available: true, models: [] });
});
