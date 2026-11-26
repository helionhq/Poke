/** Context management defaults (section 5.4). All live in settings under `context.*`. */
export interface ContextSettings {
  /** Token budget per session, clamped to the model's real context window. */
  window: number;
  /** Idle compaction only runs when the session holds more than this. */
  idleMinTokens: number;
  /** Idle compaction for Poke on Pi (Qwen) — off by default (cache lifetime undocumented). */
  idleCompactPi: boolean;
  /** Pi idle delay when idleCompactPi is on. */
  idleAfterMs: number;
  /** Minutes before cache expiry that Claude idle compaction fires. */
  idleLeadMs: number;
}

export const DEFAULT_CONTEXT_SETTINGS: ContextSettings = {
  window: 272_000,
  idleMinTokens: 80_000,
  idleCompactPi: false,
  idleAfterMs: 50 * 60 * 1000,
  idleLeadMs: 10 * 60 * 1000,
};

export function clampBudget(window: number, modelContextWindow: number | undefined): number {
  if (modelContextWindow === undefined || modelContextWindow <= 0) return window;
  return Math.min(window, modelContextWindow);
}

export type CompactionTrigger = "auto" | "idle" | "manual";

export interface CompactionRecord {
  id: string;
  sessionKind: "poke" | "executor" | "sidechat";
  sessionRef: string;
  trigger: CompactionTrigger;
  preTokens: number;
  postTokens?: number;
  runtime: "claude-agent-sdk" | "pi-durable";
  model: string;
  summary?: string;
  createdAt: number;
}

export type CacheLifetime = "1h" | "5m" | "unknown";

/** The prompt cache lifetime Claude Code used, read from usage.cache_creation. */
export function detectCacheLifetime(cacheCreation: {
  ephemeral_1h_input_tokens?: number;
  ephemeral_5m_input_tokens?: number;
}): CacheLifetime {
  const oneHour = cacheCreation.ephemeral_1h_input_tokens ?? 0;
  const fiveMin = cacheCreation.ephemeral_5m_input_tokens ?? 0;
  if (oneHour > 0 && oneHour >= fiveMin) return "1h";
  if (fiveMin > 0) return "5m";
  return "unknown";
}

/** When to run idle compaction for a Claude session, or undefined to skip it. */
export function claudeIdleCompactionDelay(lifetime: CacheLifetime, leadMs: number): number | undefined {
  if (lifetime !== "1h") return undefined; // a 5-minute cache would fire on every short pause
  return 60 * 60 * 1000 - leadMs;
}

/** Instructions every runtime gives its own model when writing a compaction summary. */
export const COMPACTION_INSTRUCTIONS = `Write the summary for Poke to continue the conversation with Arham seamlessly. Keep:
- what Arham is working on;
- open loops and promises Poke made;
- decisions and preferences he stated;
- names, dates and numbers that matter;
- the state of tasks, routines and blocks (pending questions, drafts, approvals);
- tone notes (how he writes, what lands with him);
- any activated skill instructions still in use.
Drop pleasantries and anything resolved that no longer matters. Never include secret values.`;
