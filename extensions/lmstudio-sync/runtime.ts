import { nativeApiRoot } from "./config.ts";

const MODEL_QUERY_TIMEOUT_MS = 5_000;
const MODEL_LOAD_TIMEOUT_MS = 180_000;
const MODEL_UNLOAD_TIMEOUT_MS = 60_000;

export interface LoadedModelInstance {
  id: string;
  config: Record<string, unknown>;
}

export interface NativeModelInfo {
  key: string;
  maxContextLength: number;
  loadedInstances: LoadedModelInstance[];
}

export interface RuntimeAdjustment {
  level: "info" | "warning";
  message: string;
}

export interface LoadModelOptions {
  eval_batch_size?: number;
  flash_attention?: boolean;
  num_experts?: number;
  offload_kv_cache_to_gpu?: boolean;
}

export function parseNativeModelInfo(payload: unknown, modelId: string): NativeModelInfo {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) {
    throw new Error("LM Studio returned an invalid model list");
  }
  const item = (payload as { models: unknown[] }).models.find((model) =>
    model && typeof model === "object" && (model as { key?: unknown }).key === modelId,
  ) as {
    key?: unknown;
    max_context_length?: unknown;
    loaded_instances?: unknown;
  } | undefined;
  if (!item) throw new Error(`LM Studio did not report model ${modelId}`);
  if (typeof item.key !== "string" || !Number.isSafeInteger(item.max_context_length) ||
      (item.max_context_length as number) <= 0 || !Array.isArray(item.loaded_instances)) {
    throw new Error(`LM Studio returned incomplete runtime metadata for ${modelId}`);
  }

  const loadedInstances: LoadedModelInstance[] = [];
  for (const instance of item.loaded_instances) {
    if (!instance || typeof instance !== "object") {
      throw new Error(`LM Studio returned an invalid loaded instance for ${modelId}`);
    }
    const candidate = instance as { id?: unknown; config?: unknown };
    if (typeof candidate.id !== "string" || !candidate.config || typeof candidate.config !== "object" ||
        Array.isArray(candidate.config)) {
      throw new Error(`LM Studio returned incomplete loaded-instance data for ${modelId}`);
    }
    loadedInstances.push({ id: candidate.id, config: candidate.config as Record<string, unknown> });
  }

  return {
    key: item.key,
    maxContextLength: item.max_context_length as number,
    loadedInstances,
  };
}

export async function readNativeModelInfo(
  baseUrl: string,
  modelId: string,
  fetcher: typeof fetch = fetch,
): Promise<NativeModelInfo> {
  const response = await fetcher(`${nativeApiRoot(baseUrl)}/api/v1/models`, {
    signal: AbortSignal.timeout(MODEL_QUERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LM Studio model query failed (HTTP ${response.status})`);
  return parseNativeModelInfo(await response.json(), modelId);
}

export async function readActiveRuntimeContext(
  baseUrl: string,
  modelId: string,
  fetcher: typeof fetch = fetch,
): Promise<number | undefined> {
  try {
    const info = await readNativeModelInfo(baseUrl, modelId, fetcher);
    if (info.loadedInstances.length !== 1 || info.loadedInstances[0].id !== info.key) return undefined;
    const contextLength = info.loadedInstances[0].config.context_length;
    return Number.isSafeInteger(contextLength) && (contextLength as number) > 0
      ? contextLength as number
      : undefined;
  } catch {
    return undefined;
  }
}

function preservedLoadOptions(config: Record<string, unknown>): LoadModelOptions {
  const options: LoadModelOptions = {};
  if (typeof config.eval_batch_size === "number") options.eval_batch_size = config.eval_batch_size;
  if (typeof config.flash_attention === "boolean") options.flash_attention = config.flash_attention;
  if (typeof config.num_experts === "number") options.num_experts = config.num_experts;
  if (typeof config.offload_kv_cache_to_gpu === "boolean") {
    options.offload_kv_cache_to_gpu = config.offload_kv_cache_to_gpu;
  }
  return options;
}

async function unloadModelInstance(
  baseUrl: string,
  instanceId: string,
  fetcher: typeof fetch,
): Promise<void> {
  const response = await fetcher(`${nativeApiRoot(baseUrl)}/api/v1/models/unload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance_id: instanceId }),
    signal: AbortSignal.timeout(MODEL_UNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LM Studio unload failed (HTTP ${response.status})`);
  const payload = await response.json() as { instance_id?: unknown };
  if (payload.instance_id !== instanceId) throw new Error("LM Studio did not confirm the requested instance unload");
}

async function loadModelInstance(
  baseUrl: string,
  modelId: string,
  contextLength: number,
  options: LoadModelOptions,
  fetcher: typeof fetch,
): Promise<string> {
  const response = await fetcher(`${nativeApiRoot(baseUrl)}/api/v1/models/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      context_length: contextLength,
      echo_load_config: true,
      ...options,
    }),
    signal: AbortSignal.timeout(MODEL_LOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LM Studio load failed (HTTP ${response.status})`);
  const payload = await response.json() as {
    status?: unknown;
    instance_id?: unknown;
    load_config?: { context_length?: unknown };
  };
  if (payload.status !== "loaded" || typeof payload.instance_id !== "string" ||
      payload.load_config?.context_length !== contextLength) {
    throw new Error("LM Studio did not confirm the requested context length");
  }
  return payload.instance_id;
}

export async function ensureRuntimeContext(
  baseUrl: string,
  modelId: string,
  requestedContext: number,
  endpointName: string,
  fetcher: typeof fetch = fetch,
): Promise<RuntimeAdjustment | undefined> {
  if (!Number.isSafeInteger(requestedContext) || requestedContext <= 0) {
    return { level: "warning", message: `Invalid contextWindow profile value for ${modelId}; LM Studio was not changed.` };
  }

  let info: NativeModelInfo;
  try {
    info = await readNativeModelInfo(baseUrl, modelId, fetcher);
  } catch (err) {
    return {
      level: "warning",
      message: `Could not verify LM Studio runtime for ${modelId}: ${err instanceof Error ? err.message : String(err)}. No load changes were made.`,
    };
  }

  if (requestedContext > info.maxContextLength) {
    return {
      level: "warning",
      message: `Profile requests ${requestedContext} context for ${modelId}, above LM Studio's maximum of ${info.maxContextLength}; no load changes were made.`,
    };
  }
  if (info.loadedInstances.length > 1) {
    return {
      level: "warning",
      message: `LM Studio has multiple loaded instances of ${modelId}; automatic context adjustment was skipped to avoid changing the wrong instance.`,
    };
  }

  const current = info.loadedInstances[0];
  const currentContext = current?.config.context_length;
  if (current && (current.id !== info.key || !Number.isSafeInteger(currentContext) || (currentContext as number) <= 0)) {
    return {
      level: "warning",
      message: `LM Studio's loaded instance for ${modelId} has an unexpected ID or context configuration; automatic adjustment was skipped.`,
    };
  }
  if (current && (currentContext as number) >= requestedContext) return undefined;

  const priorContext = currentContext as number | undefined;
  const priorLoadOptions = current ? preservedLoadOptions(current.config) : {};
  let unloadAttempted = false;
  try {
    if (current) {
      unloadAttempted = true;
      await unloadModelInstance(baseUrl, current.id, fetcher);
      const afterUnload = await readNativeModelInfo(baseUrl, modelId, fetcher);
      if (afterUnload.loadedInstances.length !== 0) {
        throw new Error("the previous model instance is still reported as loaded after unload");
      }
    }

    const loadedId = await loadModelInstance(baseUrl, modelId, requestedContext, priorLoadOptions, fetcher);
    if (loadedId !== info.key) {
      throw new Error(`LM Studio loaded instance ${loadedId} instead of the canonical model ID ${info.key}`);
    }
    const afterLoad = await readNativeModelInfo(baseUrl, modelId, fetcher);
    if (afterLoad.loadedInstances.length !== 1 ||
        afterLoad.loadedInstances[0].id !== info.key ||
        afterLoad.loadedInstances[0].config.context_length !== requestedContext) {
      throw new Error("the loaded instance list did not confirm exactly one instance at the requested context");
    }

    return {
      level: "info",
      message: `LM Studio loaded ${modelId} on ${endpointName} with context ${requestedContext}.`,
    };
  } catch (err) {
    let restoreNote = "";
    if (current && priorContext !== undefined && unloadAttempted) {
      try {
        const restoreState = await readNativeModelInfo(baseUrl, modelId, fetcher);
        if (restoreState.loadedInstances.length > 1) {
          throw new Error("multiple instances are now loaded; refusing to guess which one to unload");
        }
        if (restoreState.loadedInstances.length === 1) {
          const loaded = restoreState.loadedInstances[0];
          if (loaded.id !== info.key) throw new Error(`unexpected instance ${loaded.id} is loaded`);
          if (loaded.config.context_length === priorContext) {
            restoreNote = " The previous context is still active.";
          } else {
            await unloadModelInstance(baseUrl, loaded.id, fetcher);
            await loadModelInstance(baseUrl, modelId, priorContext, priorLoadOptions, fetcher);
            const restored = await readNativeModelInfo(baseUrl, modelId, fetcher);
            if (restored.loadedInstances.length !== 1 || restored.loadedInstances[0].id !== info.key ||
                restored.loadedInstances[0].config.context_length !== priorContext) {
              throw new Error("LM Studio did not confirm the previous context after reload");
            }
            restoreNote = " The previous context was restored.";
          }
        } else {
          await loadModelInstance(baseUrl, modelId, priorContext, priorLoadOptions, fetcher);
          const restored = await readNativeModelInfo(baseUrl, modelId, fetcher);
          if (restored.loadedInstances.length !== 1 || restored.loadedInstances[0].id !== info.key ||
              restored.loadedInstances[0].config.context_length !== priorContext) {
            throw new Error("LM Studio did not confirm the previous context after reload");
          }
          restoreNote = " The previous context was restored.";
        }
      } catch (restoreError) {
        restoreNote = ` WARNING: restoring the previous context also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}.`;
      }
    }
    return {
      level: "warning",
      message: `Could not apply context ${requestedContext} to ${modelId}: ${err instanceof Error ? err.message : String(err)}.${restoreNote}`,
    };
  }
}

