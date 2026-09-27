import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

// ── Constants ───────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const PROFILES_PATH = join(CONFIG_DIR, "lmstudio-profiles.json");

// Models whose names suggest they're embeddings, not chat models
const EMBEDDING_PATTERNS = [
  "embedding",
  "embed",
  "-embed-",
  "text-embedding",
  "nomic-embed",
  "gte-",
  "e5-",
];

// ── Profile types ───────────────────────────────────────────────────────────

interface ModelProfile {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isEmbeddingModel(id: string): boolean {
  const lower = id.toLowerCase();
  return EMBEDDING_PATTERNS.some((p) => lower.includes(p));
}

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

// Heuristic: guess if a model supports reasoning based on common naming patterns
function guessReasoning(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.includes("r1") ||
    lower.includes("deepseek-r") ||
    lower.includes("reason") ||
    lower.includes("-r1-")
  );
}

// Extract the parameter count (in billions) from a model id, if present.
// Names that include the size consistently format it as "<num>b" with no
// space between the number and the 'b' (e.g. "qwen/qwen3.6-27b" -> 27)
function getParameterCount(id: string): number | null {
  const matches = [...id.toLowerCase().matchAll(/(\d+(?:\.\d+)?)b/g)];
  if (matches.length === 0) return null;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isFinite(value) ? value : null;
}

// Guess context window from parameter count (in billions)
function guessContextWindow(id: string): number {
  const params = getParameterCount(id);
  if (params === null) return 128_000;
  if (params < 5) return 32_000;
  if (params < 20) return 64_000;
  return 128_000;
}

// Guess max output tokens from parameter count (in billions)
function guessMaxTokens(id: string): number {
  const params = getParameterCount(id);
  if (params === null) return 48_000;
  if (params < 5) return 16_000;
  if (params < 20) return 32_000;
  return 48_000;
}

// Format name for display, e.g. "qwen/qwen3.6-27b" -> "Qwen 3.6 27B"
function formatName(id: string): string {
  const parts = id.split("/");
  const name = parts[parts.length - 1];
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Profile loading ─────────────────────────────────────────────────────────

async function loadProfiles(): Promise<Record<string, ModelProfile>> {
  try {
    const raw = await readFile(PROFILES_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    // File doesn't exist yet or is invalid — return empty
    return {};
  }
}

// Build a complete model definition by merging defaults with profile overrides
function buildModel(
  id: string,
  profiles: Record<string, ModelProfile>,
): { model: ProviderModelConfig; source: "profile" | "default" } {
  // Start with sensible defaults
  const defaults: ProviderModelConfig = {
    id,
    name: formatName(id),
    reasoning: guessReasoning(id),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: guessContextWindow(id),
    maxTokens: guessMaxTokens(id),
  };

  // Look up profile (exact match on id)
  const profile = profiles[id];
  if (!profile) {
    return { model: defaults, source: "default" };
  }

  // Merge profile over defaults (partial overrides)
  const model: ProviderModelConfig = { ...defaults };

  if (profile.name !== undefined) model.name = profile.name;
  if (profile.reasoning !== undefined) model.reasoning = profile.reasoning;
  if (profile.thinkingLevelMap !== undefined) model.thinkingLevelMap = profile.thinkingLevelMap;
  if (profile.input !== undefined) model.input = profile.input;
  if (profile.contextWindow !== undefined) model.contextWindow = profile.contextWindow;
  if (profile.maxTokens !== undefined) model.maxTokens = profile.maxTokens;
  if (profile.compat !== undefined) model.compat = profile.compat;

  // Merge cost (partial overrides)
  if (profile.cost) {
    model.cost = { ...defaults.cost, ...profile.cost };
  }

  return { model, source: "profile" };
}

// Build a starter profile from the default guesses, used to prefill the
// editor when prompting to add a profile for a model that doesn't have one
function makeDraftProfile(id: string): ModelProfile {
  return {
    name: formatName(id),
    reasoning: guessReasoning(id),
    input: ["text"],
    contextWindow: guessContextWindow(id),
    maxTokens: guessMaxTokens(id),
  };
}

// ── Extension ───────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  const port = process.env.LM_STUDIO_PORT ?? "1234";
  const baseUrl = `http://localhost:${port}/v1`;
  let infoVisible = false;

  // Models we already prompted about this session (add or skip).
  // Lives as long as the extension instance, which pi re-creates on
  // /new, /resume, and /reload — so the skip is per-session and the
  // prompt comes up again for a new session.
  const promptedModels = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`LM Studio sync: listening on ${baseUrl}`, "info");
  });

  // ── Prompt to add a profile when a model is explicitly selected ─────────
  // Fires only on explicit selection from the model list (/model, Ctrl+P).
  // It does NOT fire at startup, /new, /resume, or /reload — those paths
  // never emit model_select.

  pi.on("model_select", async (event, ctx) => {
    const model = event.model;

    if (event.source === "restore") return;
    if (model.provider !== "lmstudio") return;
    if (promptedModels.has(model.id)) return;
    if (!ctx.hasUI) return;

    const profiles = await loadProfiles();
    if (profiles[model.id]) return;

    // Remember that we asked, so we don't nag again this session
    promptedModels.add(model.id);

    const choice = await ctx.ui.select(
      `No profile for ${model.id} — add one?`,
      ["Add profile now", "Skip (this session)"],
    );
    if (choice !== "Add profile now") {
      ctx.ui.notify("OK — won't ask about this model again this session", "info");
      return;
    }

    // Load existing profiles, or start empty if the file doesn't exist yet.
    let profilesJson: Record<string, ModelProfile> = {};
    let raw: string | undefined;
    try {
      raw = await readFile(PROFILES_PATH, "utf8");
    } catch {
      raw = undefined; // file doesn't exist yet
    }
    if (raw !== undefined) {
      try {
        profilesJson = JSON.parse(raw);
      } catch (err) {
        // Don't silently overwrite a broken file
        ctx.ui.notify(
          `Profiles file has invalid JSON — fix it first: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        return;
      }
    }

    // Prefill the editor with the current file plus a draft entry
    profilesJson[model.id] = makeDraftProfile(model.id);
    const edited = await ctx.ui.editor(
      `Add profile for ${model.id}`,
      JSON.stringify(profilesJson, null, 2) + "\n",
    );

    if (edited === undefined) {
      ctx.ui.notify("Cancelled — no profile saved", "info");
      return;
    }

    try {
      JSON.parse(edited);
    } catch (err) {
      ctx.ui.notify(
        `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
      return;
    }

    await writeFile(PROFILES_PATH, edited);
    ctx.ui.notify("Profile saved — reloading to apply", "info");

    // ctx.reload() may only be called from command handlers (it can deadlock
    // from event handlers), so queue it as a follow-up command instead.
    pi.sendUserMessage("/lmstudio-reload", { deliverAs: "followUp" });
  });

  pi.registerProvider("lmstudio", {
    baseUrl,
    apiKey: "lmstudio",
    api: "openai-completions",
    // @ts-expect-error Pi accepts provider-level compat at runtime, but the current ProviderConfig type does not expose it.
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    async refreshModels({ signal }) {
      const response = await fetch(`${baseUrl}/models`, { signal });
      if (!response.ok) return [];

      const payload = (await response.json()) as {
        data: Array<{ id: string; object?: string; owned_by?: string }>;
      };

      const profiles = await loadProfiles();

      return payload.data
        .filter((m) => !isEmbeddingModel(m.id))
        .map((m) => buildModel(m.id, profiles).model);
    },
  });

  // ── /sync-models ────────────────────────────────────────────────────────

  pi.registerCommand("sync-models", {
    description: "Refresh model list from LM Studio",
    handler: async (_args, ctx) => {
      try {
        const response = await fetch(`${baseUrl}/models`, { signal: ctx.signal });
        if (!response.ok) {
          ctx.ui.notify(`LM Studio returned ${response.status} — is it running?`, "error");
          return;
        }

        const payload = (await response.json()) as {
          data: Array<{ id: string }>;
        };

        const profiles = await loadProfiles();
        const chatModels = payload.data.filter((m) => !isEmbeddingModel(m.id));

        const profiled: string[] = [];
        const defaulted: string[] = [];
        for (const m of chatModels) {
          const { source } = buildModel(m.id, profiles);
          if (source === "profile") profiled.push(m.id);
          else defaulted.push(m.id);
        }

        ctx.ui.notify(
          `Found ${chatModels.length} chat models (${profiled.length} profiled, ${defaulted.length} defaults)`,
          "info",
        );
        ctx.ui.setStatus("lmstudio", `Synced ${chatModels.length} models`);
      } catch (err) {
        ctx.ui.notify(
          `Failed to reach LM Studio: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // ── /model-info ────────────────────────────────────────────────────────

  pi.registerCommand("model-info", {
    description: "Show current model's effective settings",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode !== "" && mode !== "full") {
        ctx.ui.notify("Usage: /model-info [full] — omit arguments for the brief summary", "error");
        return;
      }
      const full = mode === "full";

      // The brief command toggles the widget off when any model-info view is active.
      // Explicit modes always render that mode, even when the widget is already visible.
      if (mode === "" && infoVisible) {
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

      const profiles = model.provider === "lmstudio" ? await loadProfiles() : undefined;
      const metadataSource =
        model.provider === "lmstudio"
          ? profiles?.[model.id]
            ? "LM Studio profile metadata"
            : "LM Studio default metadata"
          : "Pi model registry";

      const lines = [
        "===== CURRENT MODEL INFO =====",
        `Model: ${model.name ?? model.id} (${model.provider})`,
        `  id:               ${model.id}`,
        ...(full ? [`  api:              ${model.api}`] : []),
        ...(full ? [`  baseUrl:          ${model.baseUrl}`] : []),
        `  contextWindow:    ${model.contextWindow}`,
        `  maxTokens:        ${model.maxTokens}`,
        `  input:            ${formatInputSummary(model.input, model.reasoning ?? false, ctx.thinkingLevel)}`,
        ...(full ? [`  thinkingLevelMap: ${JSON.stringify(model.thinkingLevelMap) ?? "none"}`] : []),
        ...(full ? [`  compat:           ${JSON.stringify(model.compat) ?? "none"}`] : []),
        ...(full || hasNonzeroCost(model.cost) ? formatCostLines(model.cost, { full }) : []),
        ...(model.provider === "lmstudio" ? [`  source:           ${metadataSource}`] : []),
        ...(full && model.provider === "lmstudio" ? [`  profilesFile:     ${PROFILES_PATH}`] : []),
      ];

      ctx.ui.setWidget("model-info", lines);
      infoVisible = true;
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
          // Example: customize a model's settings
          // "qwen/qwen3.6-27b": {
          //   "name": "Qwen 3.6 27B",
          //   "reasoning": true,
          //   "thinkingLevelMap": { "high": "high", "max": "max" },
          //   "contextWindow": 131072,
          //   "maxTokens": 32768
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
        // Validate JSON before writing
        try {
          JSON.parse(edited);
        } catch (err) {
          ctx.ui.notify(
            `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
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
    description: "Reload pi to apply LM Studio profile changes",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
}
