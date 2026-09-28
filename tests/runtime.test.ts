import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureRuntimeContext,
  parseNativeModelInfo,
  readActiveRuntimeContext,
} from "../extensions/lmstudio-sync/runtime.ts";

const modelId = "qwen3.8-27b";
const baseUrl = "http://lmstudio.test/v1";

type State = {
  max_context_length: number;
  loaded_instances: Array<{ id: string; config: Record<string, unknown> }>;
};

function modelResponse(state: State): Response {
  return Response.json({ models: [{ key: modelId, ...state }] });
}

function runtimeFetch(initial: State, options: { failFirstLoad?: boolean; status?: number } = {}) {
  const state: State = structuredClone(initial);
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  let failFirstLoad = options.failFirstLoad ?? false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (options.status && url.endsWith("/api/v1/models")) {
      return new Response("unsupported", { status: options.status });
    }
    if (url.endsWith("/api/v1/models") && method === "GET") return modelResponse(state);
    if (url.endsWith("/api/v1/models/unload") && method === "POST") {
      const instanceId = body?.instance_id;
      state.loaded_instances = state.loaded_instances.filter((instance) => instance.id !== instanceId);
      return Response.json({ instance_id: instanceId });
    }
    if (url.endsWith("/api/v1/models/load") && method === "POST") {
      if (failFirstLoad) {
        failFirstLoad = false;
        return new Response("load failed", { status: 500 });
      }
      const contextLength = body?.context_length as number;
      state.loaded_instances = [{
        id: modelId,
        config: {
          context_length: contextLength,
          eval_batch_size: body?.eval_batch_size,
          flash_attention: body?.flash_attention,
          num_experts: body?.num_experts,
          offload_kv_cache_to_gpu: body?.offload_kv_cache_to_gpu,
        },
      }];
      return Response.json({ status: "loaded", instance_id: modelId, load_config: { context_length: contextLength } });
    }
    return new Response("not found", { status: 404 });
  };
  return { state, calls, fetcher };
}

function emptyState(max = 131072): State {
  return { max_context_length: max, loaded_instances: [] };
}

function loadedState(contextLength: number, max = 131072): State {
  return {
    max_context_length: max,
    loaded_instances: [{
      id: modelId,
      config: {
        context_length: contextLength,
        eval_batch_size: 256,
        flash_attention: true,
        num_experts: 8,
        offload_kv_cache_to_gpu: false,
      },
    }],
  };
}

test("native model response parsing validates shape and exposes active context", async () => {
  const parsed = parseNativeModelInfo({ models: [{
    key: modelId,
    max_context_length: 131072,
    loaded_instances: [{ id: modelId, config: { context_length: 65536 } }],
  }] }, modelId);
  assert.equal(parsed.maxContextLength, 131072);
  assert.equal(parsed.loadedInstances[0].config.context_length, 65536);
  assert.throws(() => parseNativeModelInfo({ models: [] }, modelId), /did not report model/);
  assert.throws(() => parseNativeModelInfo({ models: [{ key: modelId }] }, modelId), /incomplete runtime metadata/);

  const mock = runtimeFetch(loadedState(65536));
  assert.equal(await readActiveRuntimeContext(baseUrl, modelId, mock.fetcher), 65536);
  assert.equal(mock.calls[0].url, "http://lmstudio.test/api/v1/models");
});

test("runtime reuses sufficient capacity and loads an unloaded model at the profile context", async () => {
  const sufficient = runtimeFetch(loadedState(65536));
  assert.equal(await ensureRuntimeContext(baseUrl, modelId, 32768, "Remote", sufficient.fetcher), undefined);
  assert.equal(sufficient.calls.filter((call) => call.method === "POST").length, 0);

  const unloaded = runtimeFetch(emptyState());
  const result = await ensureRuntimeContext(baseUrl, modelId, 32768, "Remote", unloaded.fetcher);
  assert.match(result?.message ?? "", /loaded .*context 32768/);
  assert.equal(unloaded.state.loaded_instances[0].config.context_length, 32768);
  assert.equal(unloaded.calls.filter((call) => call.url.endsWith("/load")).length, 1);
});

test("runtime refuses above-maximum requests and ambiguous multiple instances", async () => {
  const aboveMax = runtimeFetch(emptyState(32768));
  assert.match((await ensureRuntimeContext(baseUrl, modelId, 65536, "Remote", aboveMax.fetcher))?.message ?? "", /above LM Studio's maximum/);
  assert.equal(aboveMax.calls.filter((call) => call.method === "POST").length, 0);

  const multiple = runtimeFetch({
    max_context_length: 131072,
    loaded_instances: [
      { id: modelId, config: { context_length: 8192 } },
      { id: `${modelId}-2`, config: { context_length: 8192 } },
    ],
  });
  assert.match((await ensureRuntimeContext(baseUrl, modelId, 16384, "Remote", multiple.fetcher))?.message ?? "", /multiple loaded instances/);
  assert.equal(multiple.calls.filter((call) => call.method === "POST").length, 0);
});

test("runtime increases context while preserving supported load options", async () => {
  const mock = runtimeFetch(loadedState(8192));
  const result = await ensureRuntimeContext(baseUrl, modelId, 32768, "Remote", mock.fetcher);
  assert.match(result?.message ?? "", /context 32768/);
  assert.equal(mock.state.loaded_instances[0].config.context_length, 32768);
  const unload = mock.calls.find((call) => call.url.endsWith("/unload"));
  const load = mock.calls.find((call) => call.url.endsWith("/load"));
  assert.equal(unload?.body?.instance_id, modelId);
  assert.deepEqual(load?.body, {
    model: modelId,
    context_length: 32768,
    echo_load_config: true,
    eval_batch_size: 256,
    flash_attention: true,
    num_experts: 8,
    offload_kv_cache_to_gpu: false,
  });
});

test("runtime restores the prior context after a failed load", async () => {
  const mock = runtimeFetch(loadedState(8192), { failFirstLoad: true });
  const result = await ensureRuntimeContext(baseUrl, modelId, 32768, "Remote", mock.fetcher);
  assert.equal(result?.level, "warning");
  assert.match(result?.message ?? "", /LM Studio load failed \(HTTP 500\)/);
  assert.match(result?.message ?? "", /previous context was restored/);
  assert.equal(mock.state.loaded_instances[0].config.context_length, 8192);
  assert.equal(mock.calls.filter((call) => call.url.endsWith("/load")).length, 2);
});

test("runtime warns without mutation for invalid context, malformed, offline, and unsupported APIs", async () => {
  let invalidRequestCalls = 0;
  const invalid = await ensureRuntimeContext(baseUrl, modelId, 0, "Remote", async () => {
    invalidRequestCalls++;
    return modelResponse(emptyState());
  });
  assert.equal(invalid?.level, "warning");
  assert.equal(invalidRequestCalls, 0);

  let malformedCalls = 0;
  const malformed = await ensureRuntimeContext(baseUrl, modelId, 16384, "Remote", async () => {
    malformedCalls++;
    return Response.json({ models: "not-an-array" });
  });
  assert.match(malformed?.message ?? "", /invalid model list/);
  assert.equal(malformedCalls, 1);

  const offline = await ensureRuntimeContext(baseUrl, modelId, 16384, "Remote", async () => {
    throw new Error("connection refused");
  });
  assert.equal(offline?.level, "warning");
  assert.match(offline?.message ?? "", /connection refused/);

  const unsupported = runtimeFetch(emptyState(), { status: 404 });
  assert.match((await ensureRuntimeContext(baseUrl, modelId, 16384, "Remote", unsupported.fetcher))?.message ?? "", /HTTP 404/);
  assert.equal(unsupported.calls.filter((call) => call.method === "POST").length, 0);
});

