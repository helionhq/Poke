import { describe, expect, it } from "vitest";
import { VoyageEmbeddings } from "./index.js";

describe("voyage embeddings", () => {
  it("embeds in order with the chosen model, input type and 1024 dimensions", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const voyage = new VoyageEmbeddings({
      apiKey: () => "pa-key",
      model: () => "voyage-4",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        bodies.push(body as never);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer pa-key");
        const data = body.input
          .map((_, index) => ({ index, embedding: new Array(1024).fill(index / 10) }))
          .reverse();
        return new Response(JSON.stringify({ data, usage: { total_tokens: 7 } }), { status: 200 });
      }) as typeof fetch,
    });
    const out = await voyage.embed(["a", "b"], "query");
    expect(out.map((v) => v[0])).toEqual([0, 0.1]);
    expect(bodies[0]).toMatchObject({
      model: "voyage-4",
      input_type: "query",
      output_dimension: 1024,
      output_dtype: "float",
    });
    expect(voyage.takeTokens()).toBe(7);
  });

  it("says what's missing and refuses the wrong size", async () => {
    const unset = new VoyageEmbeddings({ apiKey: () => "k", model: () => undefined });
    expect(unset.configured()).toBe(false);
    await expect(unset.embed(["a"], "document")).rejects.toThrow(/poke model/);
    const wrong = new VoyageEmbeddings({
      apiKey: () => "k",
      model: () => "voyage-4",
      fetch: (async () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), {
          status: 200,
        })) as typeof fetch,
    });
    await expect(wrong.embed(["a"], "document")).rejects.toThrow(/2 dimensions/);
  });
});
