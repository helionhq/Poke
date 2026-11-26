import type { SearchPort, SearchResultItem } from "@poke/domain";
import { DEFAULT_BASE_URL, Keenable } from "keenable";

export interface KeenableSearchOptions {
  /** From the vault's system namespace. Without one Keenable's keyless, rate-limited tier is used. */
  apiKey(): string | undefined;
  fetch?: typeof globalThis.fetch;
}

/** Brief 11.4: compact, citable text for the model plus links for Trace details. */
export class KeenableSearch implements SearchPort {
  #client?: { key: string; keenable: Keenable };

  constructor(private readonly options: KeenableSearchOptions) {}

  async search(input: {
    query: string;
    maxResults?: number;
    site?: string;
    publishedAfter?: string;
    mode?: string;
  }): Promise<{ text: string; results: SearchResultItem[] }> {
    const response = await this.#keenable().search(input.query, {
      ...(input.maxResults ? { maxResults: input.maxResults } : {}),
      ...(input.site ? { site: input.site } : {}),
      ...(input.publishedAfter ? { publishedAfter: input.publishedAfter } : {}),
      ...(input.mode === "realtime" || input.mode === "pro" ? { mode: input.mode } : {}),
    });
    const results = response.cited().map((r) => ({
      title: r.title,
      url: r.url,
      ...(r.snippet ? { snippet: r.snippet.slice(0, 300) } : {}),
      ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    }));
    return { text: response.length ? response.toContext() : "No results.", results };
  }

  async fetch(input: { urls: string[]; maxChars?: number; prompt?: string }): Promise<{
    text: string;
    pages: Array<{ url: string; title?: string; ok: boolean }>;
  }> {
    const response = await this.#keenable().fetch(input.urls, {
      ...(input.maxChars ? { maxChars: input.maxChars } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
    });
    const blocks = response.results.map((page, i) =>
      page.error
        ? `[${i + 1}] ${page.url} - failed: ${page.error.message ?? page.error.error}`
        : page.toContext(input.maxChars ? { maxChars: input.maxChars } : {}),
    );
    return {
      text: blocks.join("\n\n"),
      pages: response.results.map((page) => ({
        url: page.url,
        ...(page.title ? { title: page.title } : {}),
        ok: !page.error,
      })),
    };
  }

  #keenable(): Keenable {
    // An empty key (not undefined) and an explicit base URL keep the SDK from reading env vars.
    const key = this.options.apiKey() ?? "";
    if (this.#client?.key !== key)
      this.#client = {
        key,
        keenable: new Keenable({
          apiKey: key,
          baseUrl: DEFAULT_BASE_URL,
          clientSource: "poke",
          ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        }),
      };
    return this.#client.keenable;
  }
}
