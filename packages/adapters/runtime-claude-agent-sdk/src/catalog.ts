import type { ModelCatalog, ModelInfo } from "@poke/domain";

export const CLAUDE_PROVIDER = "anthropic";
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Fallback list of current Claude models (Claude API reference, November 2026), for when the
 * Agent SDK's supportedModels() can't be asked (not logged in, offline). It is a catalog, not a
 * default: nothing is picked for the user.
 */
export const CURATED_CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
].map((m) => ({
  provider: CLAUDE_PROVIDER,
  ...m,
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  reasoningLevels: [...CLAUDE_EFFORT_LEVELS],
  input: ["text", "image"],
}));

/** One entry of the SDK's supportedModels(). */
export interface SdkModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  supportedEffortLevels?: string[];
}

/** Window for a model the curated list doesn't know: conservative, so the budget never overflows it. */
const UNKNOWN_WINDOW = 200_000;
const CACHE_MS = 10 * 60 * 1000;

export function fromSdkModels(models: readonly SdkModel[]): ModelInfo[] {
  const out = new Map<string, ModelInfo>();
  for (const model of models) {
    const id = [model.resolvedModel, model.value].find((v) => v && /^claude-[a-z0-9-]+$/.test(v));
    if (!id || out.has(id)) continue;
    const known = CURATED_CLAUDE_MODELS.find((m) => m.id === id);
    out.set(id, {
      provider: CLAUDE_PROVIDER,
      id,
      name: model.displayName || known?.name || id,
      contextWindow: known?.contextWindow ?? UNKNOWN_WINDOW,
      ...(known?.maxOutput ? { maxOutput: known.maxOutput } : {}),
      reasoningLevels: model.supportedEffortLevels?.length
        ? [...model.supportedEffortLevels]
        : (known?.reasoningLevels ?? []),
      input: known?.input ?? ["text", "image"],
    });
  }
  return [...out.values()];
}

export class ClaudeModelCatalog implements ModelCatalog {
  #cache: { at: number; models: ModelInfo[] } | undefined;

  /** `live` asks the Agent SDK (needs a login); without it, or when it fails, the curated list. */
  constructor(private readonly live?: () => Promise<readonly SdkModel[]>) {}

  async list(provider: string): Promise<ModelInfo[]> {
    if (provider !== CLAUDE_PROVIDER) return [];
    if (this.#cache && Date.now() - this.#cache.at < CACHE_MS)
      return this.#cache.models.map((m) => ({ ...m }));
    let models = CURATED_CLAUDE_MODELS;
    if (this.live) {
      try {
        const live = fromSdkModels(await this.live());
        if (live.length) models = live;
        this.#cache = { at: Date.now(), models };
      } catch {
        // offline or not logged in: the curated list stands in
      }
    }
    return models.map((m) => ({ ...m }));
  }

  async get(provider: string, model: string): Promise<ModelInfo | undefined> {
    return (await this.list(provider)).find((m) => m.id === model);
  }
}

/** `claude setup-token` tokens look like sk-ant-oat01-…; checked offline so login spends nothing. */
export function validateClaudeToken(token: string): { ok: true } | { ok: false; error: string } {
  if (!/^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/.test(token)) {
    return {
      ok: false,
      error:
        "That isn't a Claude setup token. Run `claude setup-token` and paste what it prints (sk-ant-oat…).",
    };
  }
  return { ok: true };
}
