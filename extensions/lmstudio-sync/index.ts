import type { ExtensionAPI, ExtensionContext, ProviderModelConfig, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { endpointBaseUrl, endpointIdFromProvider, endpointProviderId, validateEndpointConfig } from "./config.ts";
import type { EndpointConfig, LmStudioEndpoint } from "./config.ts";
import { ensureRuntimeContext, readActiveRuntimeContext } from "./runtime.ts";
import { buildModel, discoverEndpoint, guessedModelProfile, validateProfileConfig } from "./catalog.ts";
import type { ModelProfile } from "./catalog.ts";

// ── Constants ───────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const PROFILES_PATH = join(CONFIG_DIR, "lmstudio-profiles.json");
const ENDPOINTS_PATH = join(CONFIG_DIR, "lmstudio-endpoints.json");
const DEFAULT_LOCAL_ENDPOINT_ID = "local";
const DEFAULT_LOCAL_PORT = "1234";

// ── Profile types ───────────────────────────────────────────────────────────

type EndpointProfiles = Record<string, Record<string, ModelProfile>>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function hasNonzeroCost(cost: ProviderModelConfig["cost"]): boolean {
  return (
    cost.input !== 0 ||
    cost.output !== 0 ||
    cost.cacheRead !== 0 ||
    cost.cacheWrite !== 0 ||
    cost.tiers?.some((tier) =>
      tier.input !== 0 ||
      tier.output !== 0 ||
      tier.cacheRead !== 0 ||
      tier.cacheWrite !== 0
    ) === true
  );
}

function formatCostNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function formatTokenThreshold(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}k`;
  return String(tokens);
}

function formatCostParts(
  cost: ProviderModelConfig["cost"],
  options: { includeZero: boolean },
): string {
  const entries: Array<[string, number]> = [
    ["input", cost.input],
    ["output", cost.output],
    ["cache read", cost.cacheRead],
    ["cache write", cost.cacheWrite],
  ];
  const parts = entries
    .filter(([, value]) => options.includeZero || value !== 0)
    .map(([label, value]) => `${label} ${formatCostNumber(value)}`);
  return parts.length > 0 ? parts.join(", ") : "0";
}

function formatCostLines(cost: ProviderModelConfig["cost"], options: { full: boolean }): string[] {
  const includeZero = options.full;
  return [
    `  cost ($/M):       ${formatCostParts(cost, { includeZero })}`,
    ...(cost.tiers ?? []).map(
      (tier) =>
        `  tier >${formatTokenThreshold(tier.inputTokensAbove)}:       ${formatCostParts(tier, { includeZero })}`,
    ),
  ];
}

function formatInputSummary(
  input: ProviderModelConfig["input"],
  reasoning: boolean,
  thinkingLevel?: string,
): string {
  const inputText = input.join(", ");
  if (!reasoning) return inputText;
  return `${inputText} (reasoning${thinkingLevel ? `: ${thinkingLevel}` : ""})`;
}

// ── Profile loading ─────────────────────────────────────────────────────────

async function loadProfiles(): Promise<EndpointProfiles> {
  try {
    return validateProfileConfig(JSON.parse(await readFile(PROFILES_PATH, "utf8")) as unknown);
  } catch {
    // File doesn't exist yet or is invalid — return empty
    return {};
  }
}

async function loadEndpoints(): Promise<EndpointConfig> {
  try {
    const raw = await readFile(ENDPOINTS_PATH, "utf8");
    return validateEndpointConfig(JSON.parse(raw) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Create the default configuration below when the file is missing.
  }

  const port = process.env.LM_STUDIO_PORT ?? DEFAULT_LOCAL_PORT;
  const endpoints: EndpointConfig = {
    [DEFAULT_LOCAL_ENDPOINT_ID]: {
      name: "Local LM Studio",
      baseUrl: `http://localhost:${port}/v1`,
    },
  };
  await writeFile(ENDPOINTS_PATH, JSON.stringify(endpoints, null, 2) + "\n");
  return endpoints;
}

function isLmStudioProvider(provider?: string): boolean {
  return provider === "lmstudio" || provider?.endsWith("/lmstudio") === true;
}

// Build a starter profile from the default guesses, used to prefill the
// editor when prompting to add a profile for a model that doesn't have one
function makeDraftProfile(id: string, supportsImages: boolean): ModelProfile {
  return guessedModelProfile(id, supportsImages);
}

function formatJsonValue(value: unknown): string {
  if (value === undefined) return "none";
  return JSON.stringify(value, null, 2) ?? "none";
}

function buildModelInfoLines(
  model: ProviderModelConfig & { provider?: string },
  options: {
    full: boolean;
    metadataSource?: string;
    thinkingLevel?: string;
    endpointName?: string;
    runtimeContextWindow?: number;
  },
): string[] {
  if (!options.full) {
    return [
      "===== CURRENT MODEL INFO =====",
      `Model: ${model.name ?? model.id} (${model.provider ?? "unknown provider"})`,
      `  id:               ${model.id}`,
      `  contextWindow:    ${model.contextWindow}`,
      ...(options.runtimeContextWindow !== undefined
        ? [`  LM runtime:       ${options.runtimeContextWindow}`]
        : []),
      `  maxTokens:        ${model.maxTokens}`,
      `  input:            ${formatInputSummary(model.input, model.reasoning ?? false, options.thinkingLevel)}`,
      ...(isLmStudioProvider(model.provider) && options.endpointName
        ? [`  endpoint:         ${options.endpointName}`]
        : []),
      ...(hasNonzeroCost(model.cost) ? formatCostLines(model.cost, { full: false }) : []),
      ...(isLmStudioProvider(model.provider) && options.metadataSource ? [`  source:           ${options.metadataSource}`] : []),
    ];
  }

  return [
    "Current Model",
    `  Name:             ${model.name ?? model.id}`,
    `  Provider:         ${model.provider ?? "unknown"}`,
    `  ID:               ${model.id}`,
    `  API:              ${model.api ?? "provider default"}`,
    `  Base URL:         ${model.baseUrl ?? "provider default"}`,
    ...(isLmStudioProvider(model.provider) && options.endpointName
      ? [`  Endpoint:         ${options.endpointName}`]
      : []),
    "",
    "Token Limits",
    `  Context window:   ${model.contextWindow}`,
    ...(options.runtimeContextWindow !== undefined
      ? [`  LM runtime:       ${options.runtimeContextWindow}`]
      : []),
    `  Max output:       ${model.maxTokens}`,
    "",
    "Inputs and Reasoning",
    `  Input:            ${model.input.join(", ")}`,
    `  Reasoning:        ${model.reasoning ? "yes" : "no"}`,
    `  Thinking level:   ${options.thinkingLevel ?? "default"}`,
    "  Thinking map:",
    ...formatJsonValue(model.thinkingLevelMap).split("\n").map((line) => `    ${line}`),
    "",
    "Cost ($ / million tokens)",
    ...formatCostLines(model.cost, { full: true }),
    "",
    "Compatibility Metadata",
    ...formatJsonValue(model.compat).split("\n").map((line) => `  ${line}`),
    ...(isLmStudioProvider(model.provider)
      ? [
          "",
          "LM Studio Metadata",
          `  Source:           ${options.metadataSource ?? "unknown"}`,
          `  Profiles file:    ${PROFILES_PATH}`,
        ]
      : []),
  ];
}

class ModelInfoFullOverlay implements Component {
  private scrollOffset = 0;
  private readonly maxVisibleLines = 18;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly lines: string[],
    private readonly done: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data.toLowerCase() === "q") {
      this.done();
      return;
    }
    if (matchesKey(data, "up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.scrollOffset = Math.min(this.maxScrollOffset(), this.scrollOffset + 1);
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerWidth = Math.max(1, width - 2);
    const border = (text: string) => th.fg("dim", text);
    const fitLine = (text: string): string => {
      const truncated = truncateToWidth(text, innerWidth, "...", true);
      return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    };

    this.scrollOffset = Math.min(this.scrollOffset, this.maxScrollOffset());
    const visibleLines = this.lines.slice(this.scrollOffset, this.scrollOffset + this.maxVisibleLines);
    const canScrollUp = this.scrollOffset > 0;
    const canScrollDown = this.scrollOffset < this.maxScrollOffset();
    const scrollInfo = canScrollUp || canScrollDown
      ? ` ↑ ${this.scrollOffset} · ↓ ${this.maxScrollOffset() - this.scrollOffset}`
      : "";
    const title = truncateToWidth(` Model Info${scrollInfo} `, innerWidth, "...", true);
    const titlePad = Math.max(0, innerWidth - visibleWidth(title));

    const result: string[] = [border("╭") + th.fg("accent", title) + border(`${"─".repeat(titlePad)}╮`)];
    for (const line of visibleLines) {
      result.push(border("│") + fitLine(` ${line}`) + border("│"));
    }
    for (let i = visibleLines.length; i < this.maxVisibleLines; i++) {
      result.push(border("│") + fitLine("") + border("│"));
    }
    result.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    result.push(border("│") + fitLine(th.fg("dim", " ↑/↓ scroll · q/Esc close")) + border("│"));
    result.push(border("╰") + border("─".repeat(innerWidth)) + border("╯"));
    return result;
  }

  private maxScrollOffset(): number {
    return Math.max(0, this.lines.length - this.maxVisibleLines);
  }
}

class SyncResultOverlay implements Component {
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly lines: string[],
    private readonly done: () => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data.toLowerCase() === "q" || matchesKey(data, "enter")) {
      this.done();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const innerWidth = Math.max(1, width - 2);
    const border = (text: string) => th.fg("dim", text);
    const fitLine = (text: string): string => {
      const truncated = truncateToWidth(text, innerWidth, "...", true);
      return truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    };

    const title = truncateToWidth(" LM Studio Sync ", innerWidth, "...", true);
    const titlePad = Math.max(0, innerWidth - visibleWidth(title));
    const result: string[] = [border("╭") + th.fg("accent", title) + border(`${"─".repeat(titlePad)}╮`)];
    for (const line of this.lines.slice(1)) {
      result.push(border("│") + fitLine(` ${line}`) + border("│"));
    }
    result.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
    result.push(border("│") + fitLine(th.fg("dim", " q/Esc/Enter close ")) + border("│"));
    result.push(border("╰") + border("─".repeat(innerWidth)) + border("╯"));
    return result;
  }
}

// ── Extension ───────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // Remove the pre-multi-endpoint registration and its persisted catalog.
  pi.unregisterProvider("lmstudio");
  const endpoints = await loadEndpoints();
  let infoVisible = false;

  // Models we already prompted about this session (add or skip).
  // Lives as long as the extension instance, which pi re-creates on
  // /new, /resume, and /reload — so the skip is per-session and the
  // prompt comes up again for a new session.
  const promptedModels = new Set<string>();
  const runtimeAdjustments = new Map<string, Promise<{ level: "info" | "warning"; message: string } | undefined>>();

  const ensureProfileRuntimeContext = async (
    model: { provider?: string; id: string },
  ): Promise<{ level: "info" | "warning"; message: string } | undefined> => {
    const endpointId = endpointIdFromProvider(model.provider, DEFAULT_LOCAL_ENDPOINT_ID);
    if (!endpointId) return undefined;
    const endpoint = endpoints[endpointId];
    if (!endpoint || endpoint.enabled === false) return undefined;

    const profiles = await loadProfiles();
    const requestedContext = profiles[endpointId]?.[model.id]?.contextWindow;
    if (requestedContext === undefined) return undefined;

    const operationKey = `${endpointId}:${model.id}`;
    const pending = runtimeAdjustments.get(operationKey);
    if (pending) return pending;

    const operation = ensureRuntimeContext(
      endpointBaseUrl(endpoint),
      model.id,
      requestedContext,
      endpoint.name ?? endpointId,
    );
    runtimeAdjustments.set(operationKey, operation);
    try {
      return await operation;
    } finally {
      if (runtimeAdjustments.get(operationKey) === operation) runtimeAdjustments.delete(operationKey);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      `LM Studio sync: ${Object.keys(endpoints).length} endpoint${Object.keys(endpoints).length === 1 ? "" : "s"} configured`,
      "info",
    );
    if (ctx.model && isLmStudioProvider(ctx.model.provider)) {
      const runtimeAdjustment = await ensureProfileRuntimeContext(ctx.model);
      if (runtimeAdjustment && ctx.hasUI) {
        ctx.ui.notify(runtimeAdjustment.message, runtimeAdjustment.level);
      }
    }
  });

  // ── Runtime context on selection; profile prompt on explicit selection ───
  // model_select is awaited by Pi before a user/cycle model change completes.
  // session_start handles models restored or selected at process startup.
  // The profile-creation prompt remains limited to explicit interactive choices.

  pi.on("model_select", async (event, ctx) => {
    const model = event.model;
    if (!isLmStudioProvider(model.provider)) return;

    const runtimeAdjustment = await ensureProfileRuntimeContext(model);
    if (runtimeAdjustment && ctx.hasUI) {
      ctx.ui.notify(runtimeAdjustment.message, runtimeAdjustment.level);
    }

    if (event.source === "restore") return;
    if (promptedModels.has(`${model.provider}:${model.id}`)) return;
    if (!ctx.hasUI) return;

    const endpointId = endpointIdFromProvider(model.provider, DEFAULT_LOCAL_ENDPOINT_ID)!;
    const profiles = await loadProfiles();
    if (profiles[endpointId]?.[model.id]) return;

    // Remember that we asked, so we don't nag again this session
    promptedModels.add(`${model.provider}:${model.id}`);

    const choice = await ctx.ui.select(
      `No profile for ${model.id} — add one?`,
      ["Add profile now", "Skip (this session)"],
    );
    if (choice !== "Add profile now") {
      ctx.ui.notify("OK — won't ask about this model again this session", "info");
      return;
    }

    const supportsImages = await ctx.ui.confirm(
      `Vision capability for ${model.id}`,
      "Does this model accept image input? Choose No if unsure; you can edit the profile later.",
    );

    // Load existing profiles, or start empty if the file doesn't exist yet.
    let profilesJson: EndpointProfiles = {};
    let raw: string | undefined;
    try {
      raw = await readFile(PROFILES_PATH, "utf8");
    } catch {
      raw = undefined; // file doesn't exist yet
    }
    if (raw !== undefined) {
      try {
        profilesJson = validateProfileConfig(JSON.parse(raw) as unknown);
      } catch (err) {
        // Don't silently overwrite a broken file
        ctx.ui.notify(
          `Profiles file is invalid — fix it first: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }
    }

    // Prefill the editor with the current file plus a draft entry
    if (!profilesJson[endpointId]) profilesJson[endpointId] = {};
    profilesJson[endpointId][model.id] = makeDraftProfile(model.id, supportsImages);
    const edited = await ctx.ui.editor(
      `Add profile for ${model.id}`,
      JSON.stringify(profilesJson, null, 2) + "\n",
    );

    if (edited === undefined) {
      ctx.ui.notify("Cancelled — no profile saved", "info");
      return;
    }

    try {
      validateProfileConfig(JSON.parse(edited) as unknown);
    } catch (err) {
      ctx.ui.notify(
        `Invalid profile config: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    await writeFile(PROFILES_PATH, edited);
    const result = await applyProfileChanges(model, ctx.modelRegistry, ctx.signal);
    ctx.ui.notify(result, "info");
  });

  const registerEndpointProvider = (
    endpointId: string,
    endpoint: LmStudioEndpoint,
    models?: ProviderModelConfig[],
  ) => {
    const baseUrl = endpointBaseUrl(endpoint);
    const config = {
      baseUrl,
      apiKey: "lmstudio",
      api: "openai-completions" as const,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
      async refreshModels({ signal }: { signal?: AbortSignal }) {
        if (endpoint.enabled === false) return [];
        const profiles = await loadProfiles();
        const discovery = await discoverEndpoint(baseUrl, profiles[endpointId] ?? {}, signal);
        return discovery.models;
      },
      ...(models !== undefined ? { models } : endpoint.enabled === false ? { models: [] } : {}),
    };
    pi.registerProvider(endpointProviderId(endpointId), config);
  };

  for (const [endpointId, endpoint] of Object.entries(endpoints)) {
    registerEndpointProvider(endpointId, endpoint);
  }

  const refreshEndpoints = async (signal?: AbortSignal) => {
    const profiles = await loadProfiles();
    return Promise.all(Object.entries(endpoints).map(async ([endpointId, endpoint]) => {
      if (endpoint.enabled === false) {
        registerEndpointProvider(endpointId, endpoint, []);
        return {
          endpointId,
          endpoint,
          discovery: { available: false, disabled: true, models: [] },
        };
      }
      const discovery = await discoverEndpoint(
        endpointBaseUrl(endpoint),
        profiles[endpointId] ?? {},
        signal,
      );
      // Re-registration with an explicit model catalog immediately updates
      // Pi's model registry for selection by this command and future commands.
      registerEndpointProvider(endpointId, endpoint, discovery.models);
      return { endpointId, endpoint, discovery };
    }));
  };

  const applyProfileChanges = async (
    selectedModel: { provider?: string; id: string } | undefined,
    registry: ExtensionContext["modelRegistry"],
    signal?: AbortSignal,
  ): Promise<string> => {
    await refreshEndpoints(signal);
    const provider = selectedModel?.provider;
    if (!selectedModel || !provider || !isLmStudioProvider(provider)) {
      return "LM Studio profiles and model catalogs refreshed";
    }

    const updatedModel = registry.find(provider, selectedModel.id);
    if (!updatedModel) {
      return `Profile saved, but ${selectedModel.id} is currently unavailable at its endpoint`;
    }
    const selected = await pi.setModel(updatedModel);
    if (!selected) return `Profile saved, but Pi could not reselect ${selectedModel.id}`;
    const runtimeAdjustment = await ensureProfileRuntimeContext(updatedModel);
    return runtimeAdjustment
      ? `Profile saved and applied to ${selectedModel.id}. ${runtimeAdjustment.message}`
      : `Profile saved and applied to ${selectedModel.id}`;
  };

  // ── /sync-models ────────────────────────────────────────────────────────

  pi.registerCommand("sync-models", {
    description: "Refresh model lists from all LM Studio endpoints",
    handler: async (_args, ctx) => {
      const results = await refreshEndpoints(ctx.signal);
      const profiles = await loadProfiles();
      const lines = [
        "LM Studio Sync Results",
        "",
        ...results.map(({ endpointId, endpoint, discovery }) => {
          const label = endpoint.name ?? endpointId;
          if (discovery.disabled) return `${label}: disabled`;
          if (!discovery.available) {
            return `${label}: unavailable${discovery.status ? ` (${discovery.status})` : ""}`;
          }
          const endpointProfiles = profiles[endpointId] ?? {};
          const profiled = discovery.models.filter((model) =>
            buildModel(model.id, endpointProfiles).source === "profile"
          ).length;
          return `${label}: ${discovery.models.length} models (${profiled} profiled, ${discovery.models.length - profiled} defaults)`;
        }),
      ];
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => new SyncResultOverlay(tui, theme, lines, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: "50%",
            margin: { left: 0, right: 0, bottom: 3 },
          },
        },
      );
    },
  });

  // ── /set-model-from-provider ───────────────────────────────────────────

  pi.registerCommand("set-model-from-provider", {
    description: "Choose a model by provider",
    handler: async (_args, ctx) => {
      const endpointResults = await refreshEndpoints(ctx.signal);
      const endpointIds = new Set(Object.keys(endpoints).map(endpointProviderId));
      const endpointStatus = new Map(endpointResults.map(({ endpointId, discovery }) => [
        endpointProviderId(endpointId), discovery,
      ]));

      while (true) {
        const models = ctx.modelRegistry.getAll();
        const entries: Array<{ label: string; provider: string; offline?: boolean }> = [];
        for (const [endpointId, endpoint] of Object.entries(endpoints)) {
          if (endpoint.enabled === false) continue;
          const provider = endpointProviderId(endpointId);
          const discovery = endpointStatus.get(provider);
          const name = endpoint.name ?? endpointId;
          entries.push({
            label: discovery?.available
              ? `${name} — ${discovery.models.length} models`
              : `${name} — offline`,
            provider,
            offline: !discovery?.available,
          });
        }

        const byProvider = new Map<string, typeof models>();
        for (const model of models) {
          if (endpointIds.has(model.provider) || isLmStudioProvider(model.provider)) continue;
          const group = byProvider.get(model.provider) ?? [];
          group.push(model);
          byProvider.set(model.provider, group);
        }
        for (const [provider, providerModels] of byProvider) {
          if (providerModels.length === 0) continue;
          if (!ctx.modelRegistry.getProviderAuthStatus(provider).configured) continue;
          const name = ctx.modelRegistry.getProviderDisplayName(provider);
          entries.push({
            label: `${name} — ${providerModels.length} models`,
            provider,
          });
        }

        entries.sort((a, b) => a.label.localeCompare(b.label));
        const usedLabels = new Set<string>();
        for (const entry of entries) {
          const baseLabel = entry.label;
          if (usedLabels.has(entry.label)) {
            entry.label = `${baseLabel} (${entry.provider})`;
            let duplicate = 2;
            while (usedLabels.has(entry.label)) {
              entry.label = `${baseLabel} (${entry.provider} ${duplicate++})`;
            }
          }
          usedLabels.add(entry.label);
        }
        const selectedLabel = await ctx.ui.select(
          "Choose a provider",
          entries.map((entry) => entry.label),
        );
        if (selectedLabel === undefined) return;
        const selected = entries.find((entry) => entry.label === selectedLabel);
        if (!selected) return;
        if (selected.offline) continue;

        const providerModels = ctx.modelRegistry.getAll()
          .filter((model) => model.provider === selected.provider)
          .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
        if (providerModels.length === 0) continue;

        const modelLabels = providerModels.map((model) => `${model.name ?? model.id} (${model.id})`);
        const selectedModelLabel = await ctx.ui.select(
          `Choose a model — ${selected.label.split(" — ")[0]}`,
          modelLabels,
        );
        if (selectedModelLabel === undefined) continue;
        const model = providerModels[modelLabels.indexOf(selectedModelLabel)];
        if (!model) continue;

        const success = await pi.setModel(model);
        if (!success) {
          ctx.ui.notify(`Could not select ${model.id}; check authentication for ${selected.provider}.`, "warning");
        }
        return;
      }
    },
  });

  // ── /lmstudio-toggle-endpoint ─────────────────────────────────────────

  pi.registerCommand("lmstudio-toggle-endpoint", {
    description: "Enable or disable an LM Studio endpoint",
    handler: async (_args, ctx) => {
      const choices = Object.entries(endpoints).map(([id, endpoint]) => ({
        id,
        endpoint,
        label: `${endpoint.name ?? id} (${id}) — ${endpoint.enabled === false ? "disabled" : "enabled"}`,
      }));
      const choice = await ctx.ui.select(
        "Choose an endpoint to toggle",
        choices.map((entry) => entry.label),
      );
      if (choice === undefined) return;
      const selected = choices.find((entry) => entry.label === choice);
      if (!selected) return;

      const enabled = selected.endpoint.enabled === false;
      const updatedEndpoints = {
        ...endpoints,
        [selected.id]: { ...selected.endpoint, enabled },
      };
      await writeFile(ENDPOINTS_PATH, JSON.stringify(updatedEndpoints, null, 2) + "\n");
      ctx.ui.notify(
        `${selected.endpoint.name ?? selected.id} ${enabled ? "enabled" : "disabled"} — reloading to apply`,
        "info",
      );
      await ctx.reload();
    },
  });

  // ── /lmstudio-endpoints ────────────────────────────────────────────────

  pi.registerCommand("lmstudio-endpoints", {
    description: "Open LM Studio endpoints for editing",
    handler: async (_args, ctx) => {
      const edited = await ctx.ui.editor(
        `Edit endpoints (${ENDPOINTS_PATH})`,
        JSON.stringify(endpoints, null, 2) + "\n",
      );
      if (edited === undefined) return;

      try {
        const parsed = JSON.parse(edited);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
          throw new Error("expected a non-empty object of endpoint definitions");
        }
        for (const [id, endpoint] of Object.entries(parsed)) {
          if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`invalid endpoint ID: ${id}`);
          if (!endpoint || typeof endpoint !== "object" || typeof (endpoint as { baseUrl?: unknown }).baseUrl !== "string") {
            throw new Error(`endpoint ${id} must define a baseUrl`);
          }
          if ((endpoint as { enabled?: unknown }).enabled !== undefined && typeof (endpoint as { enabled?: unknown }).enabled !== "boolean") {
            throw new Error(`endpoint ${id} enabled must be a boolean`);
          }
        }
        await writeFile(ENDPOINTS_PATH, edited);
        ctx.ui.notify("Endpoints saved — reloading to apply", "info");
        await ctx.reload();
      } catch (err) {
        ctx.ui.notify(`Invalid endpoint configuration: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ── /model-info ────────────────────────────────────────────────────────

  pi.registerCommand("model-info", {
    description: "Toggle current model's brief settings widget",
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        ctx.ui.notify("Usage: /model-info — for full details, use /model-info-full", "error");
        return;
      }

      if (infoVisible) {
        ctx.ui.setWidget("model-info", undefined);
        infoVisible = false;
        ctx.ui.notify("Model info dismissed", "info");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model currently selected", "error");
        return;
      }

      const endpointId = endpointIdFromProvider(model.provider, DEFAULT_LOCAL_ENDPOINT_ID)!;
      const profiles = isLmStudioProvider(model.provider) ? await loadProfiles() : undefined;
      const metadataSource =
        isLmStudioProvider(model.provider)
          ? profiles?.[endpointId]?.[model.id]
            ? "LM Studio profile metadata"
            : "LM Studio default metadata"
          : "Pi model registry";
      const runtimeContextWindow = isLmStudioProvider(model.provider) && endpoints[endpointId]
        ? await readActiveRuntimeContext(endpointBaseUrl(endpoints[endpointId]), model.id)
        : undefined;

      ctx.ui.setWidget("model-info", buildModelInfoLines(model, {
        full: false,
        metadataSource,
        thinkingLevel: ctx.thinkingLevel,
        endpointName: isLmStudioProvider(model.provider) ? endpoints[endpointId]?.name ?? model.baseUrl : undefined,
        runtimeContextWindow,
      }));
      infoVisible = true;
    },
  });

  pi.registerCommand("model-info-full", {
    description: "Show current model's full settings in a scrollable overlay",
    handler: async (args, ctx) => {
      if (args.trim() !== "") {
        ctx.ui.notify("Usage: /model-info-full", "error");
        return;
      }

      const model = ctx.model;
      if (!model) {
        ctx.ui.notify("No model currently selected", "error");
        return;
      }

      const endpointId = endpointIdFromProvider(model.provider, DEFAULT_LOCAL_ENDPOINT_ID)!;
      const profiles = isLmStudioProvider(model.provider) ? await loadProfiles() : undefined;
      const metadataSource =
        isLmStudioProvider(model.provider)
          ? profiles?.[endpointId]?.[model.id]
            ? "LM Studio profile metadata"
            : "LM Studio default metadata"
          : "Pi model registry";
      const runtimeContextWindow = isLmStudioProvider(model.provider) && endpoints[endpointId]
        ? await readActiveRuntimeContext(endpointBaseUrl(endpoints[endpointId]), model.id)
        : undefined;
      const lines = buildModelInfoLines(model, {
        full: true,
        metadataSource,
        thinkingLevel: ctx.thinkingLevel,
        endpointName: isLmStudioProvider(model.provider) ? endpoints[endpointId]?.name ?? model.baseUrl : undefined,
        runtimeContextWindow,
      });

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => new ModelInfoFullOverlay(tui, theme, lines, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: "80%",
            margin: { left: 0, right: 0, bottom: 3 },
          },
        },
      );
    },
  });

  // ── /lmstudio-profiles ─────────────────────────────────────────────────

  pi.registerCommand("lmstudio-profiles", {
    description: "Open LM Studio model profiles for editing",
    handler: async (_args, ctx) => {
      // If the file doesn't exist, create a template
      let content: string;
      try {
        content = await readFile(PROFILES_PATH, "utf8");
      } catch {
        const template = {
          // Example: customize a model's settings for an endpoint
          // "local": {
          //   "qwen/qwen3.6-27b": {
          //     "name": "Qwen 3.6 27B",
          //     "reasoning": true,
          //     "thinkingLevelMap": { "high": "high", "max": "max" },
          //     "contextWindow": 131072,
          //     "maxTokens": 32768
          //   }
          // }
        };
        content = JSON.stringify(template, null, 2) + "\n";
        await writeFile(PROFILES_PATH, content);
        ctx.ui.notify(`Created ${PROFILES_PATH}`, "info");
      }

      // Use Pi's built-in editor dialog instead of spawning an external editor
      const edited = await ctx.ui.editor(
        `Edit profiles (${PROFILES_PATH})`,
        content,
      );

      if (edited !== undefined) {
        // User saved (not cancelled)
        // Validate JSON and profile fields before writing
        try {
          validateProfileConfig(JSON.parse(edited) as unknown);
        } catch (err) {
          ctx.ui.notify(
            `Invalid profile config: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          return;
        }

        await writeFile(PROFILES_PATH, edited);
        ctx.ui.notify("Profiles saved", "info");

        // Reload so profiles take effect
        await ctx.reload();
      }
    },
  });

  // ── /lmstudio-reload ────────────────────────────────────────────────────

  pi.registerCommand("lmstudio-reload", {
    description: "Refresh LM Studio profiles and model catalogs",
    handler: async (_args, ctx) => {
      const result = await applyProfileChanges(ctx.model, ctx.modelRegistry, ctx.signal);
      ctx.ui.notify(result, "info");
    },
  });
}
