import type { Block, Message, OutboxEntry, OutboxStorage, Trace } from "@poke/client";
import * as SQLite from "expo-sqlite";

/**
 * The offline cache (brief §20): the most recent part of the thread, the last event seq and the
 * outbox, in one SQLite file. On launch the app draws from here at once, then the event stream
 * replays whatever happened since `seq`. It is a cache: wiping it costs only a refetch.
 *
 * Nothing secret is stored here: secrets never reach messages or blocks (they are redacted on
 * the server), and the vault is never cached.
 */
export interface CachedThread {
  seq: number;
  messages: Message[];
  blocks: Block[];
  traces: Trace[];
  before?: string;
}

/** How much of the thread is kept for offline launch. */
export const CACHE_MESSAGES = 300;

export class Cache {
  readonly #db: SQLite.SQLiteDatabase;

  constructor(name = "poke-cache.db") {
    this.#db = SQLite.openDatabaseSync(name);
    this.#db.execSync(
      "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);",
    );
  }

  #get<T>(key: string): T | undefined {
    const row = this.#db.getFirstSync<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  #set(key: string, value: unknown): void {
    this.#db.runSync("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, JSON.stringify(value));
  }

  thread(serverUrl: string): CachedThread | undefined {
    const cached = this.#get<CachedThread & { server: string }>("thread");
    // A cache from another server (re-paired elsewhere) is useless.
    return cached && cached.server === serverUrl ? cached : undefined;
  }

  saveThread(serverUrl: string, thread: CachedThread): void {
    const messages = thread.messages.slice(-CACHE_MESSAGES);
    const keep = new Set(messages.map((m) => m.id));
    this.#set("thread", {
      server: serverUrl,
      seq: thread.seq,
      messages,
      blocks: thread.blocks.filter((b) => keep.has(b.messageId)),
      traces: thread.traces.filter((t) => keep.has(t.messageId)),
      // The oldest cached message is where scrolling up continues from.
      ...(messages[0] ? { before: messages[0].id } : {}),
    });
  }

  /** Small app preferences (wallpaper, last side chat model shown). */
  pref<T>(key: string, fallback: T): T {
    return this.#get<T>(`pref:${key}`) ?? fallback;
  }
  setPref(key: string, value: unknown): void {
    this.#set(`pref:${key}`, value);
  }

  outboxStorage(): OutboxStorage {
    return {
      load: async () => this.#get<OutboxEntry[]>("outbox") ?? [],
      save: async (entries) => this.#set("outbox", entries),
    };
  }

  clear(): void {
    this.#db.runSync("DELETE FROM kv");
  }
}
