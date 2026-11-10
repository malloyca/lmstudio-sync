import assert from "node:assert/strict";
import test from "node:test";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { createOmlxProvider } from "../extensions/lmstudio-sync/omlx-provider.ts";
import { omlxBaseUrl, omlxFetch, validateOmlxEndpointConfig } from "../extensions/lmstudio-sync/omlx-security.ts";
import { discoveryFailureLabel } from "../extensions/lmstudio-sync/catalog.ts";

const endpoint = { name: "Local oMLX", baseUrl: "http://localhost:8000/v1" };
const context: Context = { messages: [{ role: "user", content: "Hello", timestamp: 0 }] };
const catalog = () => Response.json({ data: [
  { id: "qwen3-8b", model_type: "llm" },
  { id: "qwen3.6-35b-a3b-dflash2", model_type: "llm" },
  { id: "incoai/Qwen3.8-27B-DFlash2", model_type: "llm" },
] });
const login = async (runtime: ReturnType<typeof createModels>, id = "local/omlx", key = "test-only-local-key") =>
  runtime.login(id, "api_key", {
    prompt: async (prompt) => { assert.equal(prompt.type, "secret"); return key; },
    notify: () => {},
  });
const registry = (runtime: ReturnType<typeof createModels>) => ({ getProviderAuth: (id: string) => runtime.getAuth(id) });

function sse(toolCall = false): Response {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", ...(toolCall
      ? { tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "test_tool", arguments: '{"value":7}' } }] }
      : { content: "Hello from oMLX" }) }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
  ].map((chunk) => ({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "qwen3-8b", ...chunk }));
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("oMLX validates transport and keeps secrets out of endpoint config and errors", () => {
  for (const url of ["http://localhost:8000/v1/", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1", "https://models.example/v1"]) {
    assert.ok(omlxBaseUrl(url));
  }
  const secret = "test-only-secret";
  for (const url of [
    "http://models.example/v1", "http://host.docker.internal:8000/v1", "file:///v1", "not a URL",
    `https://user:${secret}@models.example/v1`, `https://models.example/v1?key=${secret}`, `https://models.example/v1#${secret}`,
  ]) {
    assert.throws(() => omlxBaseUrl(url), (error: Error) => !error.message.includes(secret));
  }
  for (const field of ["apiKey", "headers", "token"]) {
    assert.throws(() => validateOmlxEndpointConfig({ local: { ...endpoint, [field]: secret } }),
      (error: Error) => error.message.includes("/login") && !error.message.includes(secret));
  }
  assert.deepEqual(validateOmlxEndpointConfig({ local: endpoint }), { local: endpoint });
});

test("Pi-managed credentials are isolated per provider and used for discovery, chat, and tools", async () => {
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const runtime = createModels({ credentials, modelsStore });
  const sent: Array<{ url: string; authorization: string | null }> = [];
  let toolCall = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const authorization = new Headers(init?.headers).get("Authorization");
    sent.push({ url, authorization });
    assert.equal(init?.redirect, "manual");
    if (url.endsWith("/models")) return catalog();
    assert.equal(url, "http://localhost:8000/v1/chat/completions");
    assert.ok(!String(init?.body).includes("test-only-local-key"));
    return sse(toolCall);
  };
  const local = createOmlxProvider("local", endpoint, fetcher);
  const remote = createOmlxProvider("remote", { baseUrl: "https://models.example/v1" }, fetcher);
  runtime.setProvider(local.provider);
  runtime.setProvider(remote.provider);

  assert.equal((await local.refresh(registry(runtime))).reason, "auth_required");
  assert.equal(sent.length, 0);
  await login(runtime);
  const result = await runtime.refresh();
  assert.equal(result.errors.size, 0);
  assert.deepEqual(runtime.getModels("local/omlx").map((model) => model.id), ["qwen3-8b"]);
  assert.equal(sent.length, 1); // The unsigned remote provider was not probed.
  assert.equal(sent[0].authorization, "Bearer test-only-local-key");
  assert.equal(await runtime.getAuth("remote/omlx"), undefined);
  assert.equal(await modelsStore.read("local/omlx"), undefined); // No persisted catalog/key.

  const model = runtime.getModel("local/omlx", "qwen3-8b")!;
  assert.ok(!JSON.stringify(model).includes("test-only-local-key"));
  let responses = 0;
  let payloads = 0;
  const answer = await runtime.completeSimple(model, context, {
    maxTokens: 32, maxRetries: 0,
    onResponse: () => { responses++; }, onPayload: () => { payloads++; },
  });
  assert.equal(answer.stopReason, "stop");
  assert.deepEqual(answer.content, [{ type: "text", text: "Hello from oMLX" }]);
  assert.equal(answer.usage.totalTokens, 7);
  assert.equal(responses, 1);
  assert.equal(payloads, 1);

  toolCall = true;
  const toolAnswer = await runtime.complete(model, {
    ...context, tools: [{ name: "test_tool", description: "Test only", parameters: { type: "object", properties: { value: { type: "number" } } } }],
  }, { maxTokens: 32, maxRetries: 0 });
  assert.equal(toolAnswer.stopReason, "toolUse");
  assert.ok(toolAnswer.content.some((part) => part.type === "toolCall" && part.name === "test_tool" && part.arguments.value === 7));
  assert.ok(sent.every((request) => request.authorization === "Bearer test-only-local-key"));

  // A second endpoint gets its own key, not an inherited local credential.
  await login(runtime, "remote/omlx", "test-only-remote-key");
  const remoteCatalog = await remote.refresh(registry(runtime));
  assert.deepEqual(remoteCatalog.models.map((model) => model.id), ["qwen3-8b"]);
  assert.deepEqual(sent.at(-1), { url: "https://models.example/v1/models", authorization: "Bearer test-only-remote-key" });

  // Rotation takes effect at the next request, without reloading the extension.
  await login(runtime, "local/omlx", "test-only-rotated-key");
  await local.refresh(registry(runtime));
  assert.equal(sent.at(-1)!.authorization, "Bearer test-only-rotated-key");
  await runtime.logout("local/omlx");
  const before = sent.length;
  assert.equal((await local.refresh(registry(runtime))).reason, "auth_required");
  assert.deepEqual(local.provider.getModels(), []);
  assert.equal(sent.length, before);
});

test("changing an oMLX URL requires a new login and never sends the old key", async () => {
  const runtime = createModels({ credentials: new InMemoryCredentialStore() });
  const old = createOmlxProvider("local", endpoint, async () => catalog());
  runtime.setProvider(old.provider);
  await login(runtime);
  let calls = 0;
  const changed = createOmlxProvider("local", { baseUrl: "https://different.example/v1" }, async () => { calls++; return catalog(); });
  runtime.setProvider(changed.provider);
  assert.equal(await runtime.getAuth("local/omlx"), undefined);
  assert.equal((await changed.refresh(registry(runtime))).reason, "auth_required");
  await runtime.refresh();
  assert.equal(calls, 0);
  await login(runtime, "local/omlx", "test-only-new-server-key");
  await runtime.refresh();
  assert.equal(calls, 1);
});

test("authenticated transport rejects redirects and discards bodies, headers, and exceptions", async () => {
  const secret = "test-only-echoed-secret";
  for (const status of [301, 302, 307, 308, 401, 403, 500]) {
    let calls = 0;
    const guarded = omlxFetch(endpoint.baseUrl, async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response(secret, { status, statusText: secret, headers: { Location: `https://evil.example/${secret}`, "X-Secret": secret } });
    });
    const result = await guarded(`${endpoint.baseUrl}/models`, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(result.status, status);
    assert.ok(!(await result.text()).includes(secret));
    assert.equal(result.headers.get("Location"), null);
    assert.equal(result.headers.get("X-Secret"), null);
    assert.equal(calls, 1);
    await assert.rejects(guarded("https://evil.example/v1/models"), /endpoint does not match/);
    assert.equal(calls, 1);
  }
  const throwing = omlxFetch(endpoint.baseUrl, async () => { throw new Error(secret); });
  await assert.rejects(throwing(`${endpoint.baseUrl}/models`), (error: Error) => !error.message.includes(secret));
});

test("authentication failures have safe labels and clear previously discovered models", async () => {
  for (const status of [401, 403, 307]) {
    const runtime = createModels({ credentials: new InMemoryCredentialStore() });
    let reject = false;
    const controller = createOmlxProvider("local", endpoint, async () => reject
      ? new Response("test-only-local-key", { status, headers: { Location: "https://evil.example/v1/models" } }) : catalog());
    runtime.setProvider(controller.provider);
    await login(runtime);
    await controller.refresh(registry(runtime));
    assert.equal(controller.provider.getModels().length, 1);
    reject = true;
    const result = await controller.refresh(registry(runtime));
    assert.equal(result.reason, status === 307 ? "redirect_refused" : "auth_rejected");
    assert.deepEqual(controller.provider.getModels(), []);
    assert.ok(!JSON.stringify(result).includes("test-only-local-key"));
    assert.match(discoveryFailureLabel(result), status === 307 ? /redirect refused/ : /authentication rejected/);
  }
});

test("inference errors cannot echo credentials into session-visible error messages", async () => {
  for (const status of [401, 500]) {
    const runtime = createModels({ credentials: new InMemoryCredentialStore() });
    const controller = createOmlxProvider("local", endpoint, async (input) => String(input).endsWith("/models")
      ? catalog() : Response.json({ error: { message: "test-only-local-key" } }, { status }));
    runtime.setProvider(controller.provider);
    await login(runtime);
    await runtime.refresh();
    const result = await runtime.completeSimple(runtime.getModels()[0], context, { maxRetries: 0 });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /oMLX inference failed/);
    assert.ok(!JSON.stringify(result).includes("test-only-local-key"));
  }
});

test("disabled and cancelled providers do not publish catalogs or resolve disabled credentials", async () => {
  let requests = 0;
  const controller = createOmlxProvider("local", { ...endpoint, enabled: false }, async () => { requests++; return catalog(); });
  const result = await controller.refresh({ getProviderAuth: async () => { throw new Error("must not resolve"); } });
  assert.equal(result.disabled, true);
  assert.equal(requests, 0);

  const runtime = createModels({ credentials: new InMemoryCredentialStore() });
  const active = createOmlxProvider("local", endpoint, async () => { requests++; return catalog(); });
  runtime.setProvider(active.provider);
  await login(runtime);
  const abort = new AbortController();
  abort.abort();
  await runtime.refresh({ signal: abort.signal });
  assert.equal(requests, 0);
  assert.deepEqual(active.provider.getModels(), []);
});

test("invalid credentials and credential-store errors are never sent or displayed", async () => {
  let requests = 0;
  const controller = createOmlxProvider("local", endpoint, async () => { requests++; return catalog(); });
  const credentials = new InMemoryCredentialStore();
  const runtime = createModels({ credentials });
  runtime.setProvider(controller.provider);
  for (const key of ["", "  ", "test-only-key\r\nX-Injected: value"]) {
    await assert.rejects(login(runtime, "local/omlx", key), /non-empty oMLX API key/);
  }
  // A plain manually inserted key, without the login's URL binding, fails closed.
  await credentials.modify("local/omlx", async () => ({ type: "api_key", key: "test-only-unbound-key" }));
  assert.equal(await runtime.getAuth("local/omlx"), undefined);
  assert.equal((await controller.refresh(registry(runtime))).reason, "auth_required");
  const result = await controller.refresh({ getProviderAuth: async () => { throw new Error("test-only-store-secret"); } });
  assert.equal(result.reason, "auth_unavailable");
  assert.ok(!JSON.stringify(result).includes("test-only-store-secret"));
  assert.equal(requests, 0);
});
