import type { Embeddings, ModelCatalog, ModelInfo } from "@poke/domain";

export const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
/** Honcho's vector column is sized once at first boot (section 13); Voyage 4 models default to 1024. */
export const VOYAGE_DIMENSIONS = 1024;
const MAX_BATCH = 128;

export interface VoyageOptions {
  /** From the vault's system namespace (`poke login voyage`). */
  apiKey(): string | undefined;
  /** The Memory embeddings model (`poke model`), e.g. voyage-4. Unset: embeddings are off. */
  model(): string | undefined;
  dimensions?: number;
  fetch?: typeof globalThis.fetch;
}

export class VoyageError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Voyage AI embeddings over its REST API (docs.voyageai.com/reference/embeddings-api). */
export class VoyageEmbeddings implements Embeddings {
  readonly dimensions: number;
  #tokens = 0;

  constructor(private readonly options: VoyageOptions) {
    this.dimensions = options.dimensions ?? VOYAGE_DIMENSIONS;
  }

  model(): string | undefined {
    return this.options.model();
  }

  configured(): boolean {
    return Boolean(this.options.apiKey() && this.options.model());
  }

  /** Tokens used since the last call to this method (for usage records). */
  takeTokens(): number {
    const tokens = this.#tokens;
    this.#tokens = 0;
    return tokens;
  }

  async embed(input: string[], kind: "document" | "query"): Promise<number[][]> {
    const key = this.options.apiKey();
    const model = this.options.model();
    if (!key) throw new VoyageError("Voyage isn't logged in. Run `poke login voyage`.");
    if (!model) throw new VoyageError("The Memory embeddings model isn't set. Run `poke model`.");
    const out: number[][] = [];
    for (let i = 0; i < input.length; i += MAX_BATCH) {
      const batch = input.slice(i, i + MAX_BATCH);
      const response = await (this.options.fetch ?? fetch)(VOYAGE_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          input: batch,
          model,
          input_type: kind,
          output_dimension: this.dimensions,
          output_dtype: "float",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new VoyageError(
          `Voyage answered ${response.status}${detail ? `: ${detail}` : ""}`,
          response.status,
        );
      }
      const body = (await response.json()) as {
        data?: Array<{ embedding: number[]; index: number }>;
        usage?: { total_tokens?: number };
      };
      const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== batch.length)
        throw new VoyageError("Voyage returned the wrong number of embeddings");
      for (const item of data) {
        if (item.embedding.length !== this.dimensions)
          throw new VoyageError(
            `Voyage returned ${item.embedding.length} dimensions, Honcho expects ${this.dimensions}`,
          );
        out.push(item.embedding);
      }
      this.#tokens += body.usage?.total_tokens ?? 0;
    }
    return out;
  }
}

/**
 * The Voyage 4 family (docs.voyageai.com/docs/embeddings, checked 2026-11): 1024 dimensions by
 * default, with 256/512/2048 also offered. Poke always asks for 1024.
 */
const VOYAGE_MODELS: ModelInfo[] = [
  {
    provider: "voyage",
    id: "voyage-4",
    name: "Voyage 4",
    contextWindow: 32_000,
    reasoningLevels: [],
    input: ["text"],
  },
  {
    provider: "voyage",
    id: "voyage-4-large",
    name: "Voyage 4 Large",
    contextWindow: 32_000,
    reasoningLevels: [],
    input: ["text"],
  },
];

export class VoyageCatalog implements ModelCatalog {
  async list(): Promise<ModelInfo[]> {
    return VOYAGE_MODELS;
  }

  async get(_provider: string, model: string): Promise<ModelInfo | undefined> {
    return VOYAGE_MODELS.find((m) => m.id === model);
  }
}

/** `poke login voyage`: one tiny embedding proves the key works. */
export async function validateVoyageKey(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const voyage = new VoyageEmbeddings({ apiKey: () => key, model: () => "voyage-4", fetch: fetchImpl });
    await voyage.embed(["ok"], "query");
    return { ok: true };
  } catch (error) {
    if (error instanceof VoyageError && (error.status === 401 || error.status === 403))
      return { ok: false, error: "Voyage didn't accept that key" };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
