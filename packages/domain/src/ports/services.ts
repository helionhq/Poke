import type { VaultEntry, VaultKind, SystemSecretKey } from "../vault.js";

export interface MemoryPort {
  /** False when the Memory models aren't set or Honcho isn't deployed. */
  available(): boolean;
  /** One completed main-thread exchange (Arham's message, Poke's final reply). */
  addExchange(exchange: {
    user?: { text: string; at: number };
    poke?: { text: string; at: number };
  }): Promise<void>;
  /** Dialectic query about Arham. */
  recall(query: string, level?: "minimal" | "low" | "medium" | "high" | "max"): Promise<string>;
  /** Explicit memory. Returns a ref Undo can delete. */
  remember(fact: string): Promise<{ ref: string }>;
  forget(ref: string): Promise<void>;
  /** Peer card / representation for the digest at session start. */
  peerCard(): Promise<string | undefined>;
}

export interface VaultPutInput {
  name: string;
  kind: VaultKind;
  fields?: Record<string, string>;
  secrets: Record<string, string>;
  description?: string;
  usedBy?: string[];
  ephemeral?: boolean;
  expiresAt?: number;
}

export interface VaultPort {
  list(): VaultEntry[];
  get(name: string): VaultEntry | undefined;
  put(input: VaultPutInput): VaultEntry;
  /** Merge secret fields into an existing entry (e.g. a password added to a known login). */
  update(name: string, patch: Partial<Omit<VaultPutInput, "name">>): VaultEntry;
  delete(name: string): boolean;
  /** Face ID–gated reveal on a paired device. Never reachable from an agent. */
  reveal(name: string): Record<string, string>;
  /** SecretResolver: substitute inside a tool executor only. */
  resolve(name: string, field?: string): string | undefined;
  markUsed(name: string, by?: string): void;
  /** Every live secret value (user vault and system namespace) for output redaction. */
  liveSecrets(): Array<{ name: string; value: string }>;
  /** Wipe expired / used one-time codes. */
  sweep(now: number): string[];
  system: SystemSecrets;
}

export interface SystemSecrets {
  get(key: SystemSecretKey): string | undefined;
  set(key: SystemSecretKey, value: string): void;
  delete(key: SystemSecretKey): void;
  has(key: SystemSecretKey): boolean;
  keys(): SystemSecretKey[];
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

export interface SearchPort {
  search(input: {
    query: string;
    maxResults?: number;
    site?: string;
    publishedAfter?: string;
    mode?: string;
  }): Promise<{ text: string; results: SearchResultItem[] }>;
  fetch(input: { urls: string[]; maxChars?: number; prompt?: string }): Promise<{
    text: string;
    pages: Array<{ url: string; title?: string; ok: boolean }>;
  }>;
}

export interface SttSession {
  /** 16 kHz mono PCM16 little-endian. */
  send(pcm: Uint8Array): void;
  /** Ask the service to end the current turn now. */
  forceEndpoint(): void;
  close(): Promise<void>;
}

export interface SttEvents {
  onPartial(text: string): void;
  /** A finished turn (turn detection). */
  onTurn(text: string): void;
  onError(error: Error): void;
  onClose?(): void;
}

export interface SpeechToText {
  open(events: SttEvents, opts?: { sampleRate?: number; formatTurns?: boolean }): Promise<SttSession>;
}

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
}

export interface TextToSpeech {
  voices(): Promise<TtsVoice[]>;
  /** Streams audio chunks (format given by the adapter). */
  synthesize(text: string, opts: { voice?: string; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  readonly audioFormat: { mime: string; sampleRate?: number };
}

export interface Notification {
  title: string;
  body: string;
  url?: string;
  level?: "active" | "timeSensitive" | "passive";
  group?: string;
  sound?: string;
}

export interface Notifier {
  configured(): boolean;
  send(notification: Notification): Promise<void>;
}

export interface Embeddings {
  embed(input: string[], kind: "document" | "query"): Promise<number[][]>;
  readonly dimensions: number;
}

export interface FileStore {
  /** Absolute root of the library (attachments) folder. */
  readonly libraryRoot: string;
  readonly workspaceRoot: string;
  write(relPath: string, data: Uint8Array): Promise<void>;
  read(relPath: string): Promise<Uint8Array>;
  absolute(relPath: string): string;
  exists(relPath: string): boolean;
}

export interface Logger {
  debug(obj: Record<string, unknown> | string, msg?: string): void;
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

export interface Timers {
  setTimeout(fn: () => void, ms: number): { cancel(): void };
}
