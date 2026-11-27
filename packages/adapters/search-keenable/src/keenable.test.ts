import { describe, expect, it } from "vitest";
import { KeenableSearch } from "./index.js";

function fakeFetch(calls: Array<{ url: string; headers: Headers; body: unknown }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    const data = url.includes("/v1/search")
      ? {
          query: "lisbon",
          results: [
            { title: "Lisbon stays", url: "https://example.com/a", snippet: "Alfama flats with a view" },
          ],
        }
      : {
          results: [
            { url: "https://example.com/a", title: "A", content: "Hello page" },
            {
              url: "https://example.com/b",
              error: { status: 404, error: "not_found", message: "Not found" },
            },
          ],
        };
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("keenable search", () => {
  it("searches with the vault key and renders citable text", async () => {
    process.env.KEENABLE_API_KEY = "env-key-must-not-be-used";
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const search = new KeenableSearch({ apiKey: () => "keen_vault", fetch: fakeFetch(calls) });
    const out = await search.search({ query: "lisbon", maxResults: 3, site: "example.com" });
    expect(out.results).toEqual([
      { title: "Lisbon stays", url: "https://example.com/a", snippet: "Alfama flats with a view" },
    ]);
    expect(out.text).toContain("[1] Lisbon stays (https://example.com/a)");
    expect(calls[0]!.url).toBe("https://api.keenable.ai/v1/search");
    expect(calls[0]!.headers.get("x-api-key")).toBe("keen_vault");
    delete process.env.KEENABLE_API_KEY;
  });

  it("goes keyless without a key, and reports pages that failed", async () => {
    process.env.KEENABLE_API_KEY = "env-key-must-not-be-used";
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const search = new KeenableSearch({ apiKey: () => undefined, fetch: fakeFetch(calls) });
    const out = await search.fetch({ urls: ["https://example.com/a", "https://example.com/b"] });
    expect(calls[0]!.url).toBe("https://api.keenable.ai/v1/fetch/public");
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
    expect(out.pages).toEqual([
      { url: "https://example.com/a", title: "A", ok: true },
      { url: "https://example.com/b", ok: false },
    ]);
    expect(out.text).toContain("Hello page");
    expect(out.text).toContain("[2] https://example.com/b - failed: Not found");
    delete process.env.KEENABLE_API_KEY;
  });
});
