import { describe, expect, it } from "vitest";
import { BarkNotifier } from "./index.js";

describe("Bark", () => {
  it("posts Bark's push JSON and reports failures", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let status = 200;
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(status === 200 ? '{"code":200}' : "bad key", { status });
    }) as unknown as typeof fetch;
    const state: { key?: string } = {};
    const bark = new BarkNotifier({
      url: () => "https://bark.example/",
      deviceKey: () => state.key,
      fetch: fetcher,
    });
    expect(bark.configured()).toBe(false);
    await expect(bark.send({ title: "Poke", body: "hi" })).rejects.toThrow(/isn't set up/);

    state.key = "dev-key";
    await bark.send({
      title: "Poke",
      body: "Booked.",
      url: "poke://thread?message=msg_1",
      group: "poke",
      level: "timeSensitive",
    });
    expect(calls).toEqual([
      {
        url: "https://bark.example/push",
        body: {
          device_key: "dev-key",
          title: "Poke",
          body: "Booked.",
          url: "poke://thread?message=msg_1",
          group: "poke",
          level: "timeSensitive",
        },
      },
    ]);

    status = 400;
    await expect(bark.send({ title: "Poke", body: "x" })).rejects.toThrow("Bark answered 400: bad key");
  });
});
