import type { Message } from "@poke/client";
import { Cache } from "../lib/cache";

jest.mock("expo-sqlite", () => {
  const rows = new Map<string, string>();
  return {
    openDatabaseSync: () => ({
      execSync: () => {},
      getFirstSync: (_sql: string, key: string) => (rows.has(key) ? { value: rows.get(key) } : null),
      runSync: (sql: string, ...args: string[]) => {
        if (sql.startsWith("DELETE")) rows.clear();
        else rows.set(args[0]!, args[1]!);
      },
    }),
  };
});

const message = (id: string, createdAt: number): Message => ({
  id,
  scope: "main",
  role: "poke",
  parts: [{ type: "text", text: id }],
  status: "complete",
  origin: { kind: "turn" },
  createdAt,
  updatedAt: createdAt,
});

describe("Cache", () => {
  it("saves where scrolling up continues from as the server's cursor", () => {
    const cache = new Cache();
    cache.saveThread("https://poke.example.com", {
      seq: 7,
      messages: [message("msg_a", 1000), message("msg_b", 2000)],
      blocks: [],
      traces: [],
    });
    expect(cache.thread("https://poke.example.com")?.before).toBe("1000:msg_a");
    expect(cache.thread("https://other.example.com")).toBeUndefined();
  });
});
