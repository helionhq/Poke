import type { VaultEntry, VaultKind, SystemSecretKey } from "../vault.js";
import type { McpServerConfig } from "../integration.js";
import type { JsonSchema, ToolOutputItem } from "./runtime.js";

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

export interface CryptoPort {
  randomBytes(length: number): Uint8Array;
  /** URL-safe random token (base64url). */
  randomToken(bytes?: number): string;
  sha256Hex(data: string | Uint8Array): string;
  /** Constant-time string comparison. */
  safeEqual(a: string, b: string): boolean;
}

// ── MCP (local servers, browse, Executor) ────────────────────────────────────────────────────

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
}

export interface McpCallResult {
  output: ToolOutputItem[];
  /** The server's structuredContent, when it sent one. */
  structured?: unknown;
  isError: boolean;
}

/** One live connection to an MCP server. */
export interface McpSession {
  tools(): Promise<McpToolInfo[]>;
  call(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<McpCallResult>;
  /** Called once when the connection drops (the process exited, the server went away). */
  onClose(listener: () => void): void;
  close(): Promise<void>;
}

export interface McpConnector {
  connect(transport: McpServerConfig["transport"], opts?: { name?: string }): Promise<McpSession>;
}

// ── Executor Cloud ───────────────────────────────────────────────────────────────────────────

export type ExecutorMetaTool = "skills" | "search" | "describe" | "call" | "execute";

/** What a `call`, `execute` or `resume` came back with (Executor's McpExecutionResult). */
export type ExecutorOutcome =
  | { status: "completed"; result: unknown; text: string }
  | {
      status: "approval-required";
      requestId: string;
      app: string;
      tool: string;
      kind?: "query" | "mutation";
      input: Record<string, unknown>;
      message: string;
      expiresAt?: number;
    }
  | {
      status: "input-required";
      requestId: string;
      app: string;
      tool: string;
      message: string;
      schema?: Record<string, unknown>;
      expiresAt?: number;
    }
  | { status: "unavailable"; requestId?: string; reason: string; message: string }
  /** Anything else (busy, capacity-exceeded, a transport error): passed to the agent as text. */
  | { status: "other"; text: string; isError: boolean };

export interface ExecutorCatalogApp {
  id: string;
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  auth: Array<{ method: string; kind: string; label?: string }>;
}

export interface ExecutorPort {
  /** Token and organization are both set. */
  configured(): boolean;
  /** The read-only meta-tools (`skills`, `search`, `describe`) and `call` / `execute`. */
  run(tool: ExecutorMetaTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutorOutcome>;
  /** Answer a paused call: accept or decline an approval, or fill in an input request. */
  resume(
    requestId: string,
    response: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<ExecutorOutcome>;
  /** Start connecting an account for an app's requirement: the link the user opens. */
  connect(app: string, requirement?: string): Promise<{ url: string; connectionId: string }>;
  connection(connectionId: string): Promise<{
    status: "pending" | "expired" | "cancelled" | "completed";
    account?: string;
  }>;
  catalog(): Promise<ExecutorCatalogApp[]>;
  close(): Promise<void>;
}

/** A folder holding a SKILL.md, found on disk or in a downloaded source. */
export interface SkillFolder {
  /** Folder name (what the skill's `name` must match). */
  folder: string;
  /** SKILL.md text. */
  text: string;
  /** Absolute path to SKILL.md once installed; the staged path while staged. */
  location: string;
}

/** The skills folder (~/poke/skills) and installing into it. */
export interface SkillFiles {
  readonly root: string;
  /** Every skill folder under the root (one level deep). */
  scan(): Promise<SkillFolder[]>;
  /**
   * Fetches and unpacks a source (an https URL to a SKILL.md, a GitHub folder or repo, a zip or
   * tarball, or a local file or folder) into a staging area and lists the skill folders in it.
   */
  stage(source: string): Promise<{ id: string; skills: SkillFolder[] }>;
  /** Moves a staged folder into place as `<root>/<name>`, replacing what's there. Returns SKILL.md's path. */
  commit(stageId: string, folder: string, name: string): Promise<string>;
  discard(stageId: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Bundled files of an installed skill, relative to its folder (SKILL.md left out). */
  resources(name: string): Promise<string[]>;
}
