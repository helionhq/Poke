import type {
  AppSettings,
  AppSettingsPatch,
  Block,
  BlockActionRequest,
  IntegrationPatchRequest,
  Message,
  PairRequest,
  RoutinePatchRequest,
  SendMessageRequest,
  ThreadInfo,
  ThreadPage,
  SearchResponse,
  VoiceInfo,
  WorkspaceListing,
} from "@poke/contracts";
import type {
  ApprovalRule,
  Attachment,
  Device,
  Integration,
  McpServer,
  CatalogApp,
  RoutineView,
  RoutineRun,
  Skill,
  Step,
  Task,
  Trace,
  VaultEntry,
} from "./types.js";

/** A failed request, with the server's code and readable message. */
export class PokeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PokeError";
  }

  /** The request never reached Poke (offline, server down, DNS). Safe to retry later. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export interface ClientOptions {
  /** `https://poke.example.com` (no trailing slash needed). */
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Sent on every request, e.g. Cloudflare Access service-token headers from the pairing code. */
  headers?: Record<string, string>;
}

type Query = Record<string, string | number | boolean | undefined>;

/** Typed REST client for Poke's API (docs/API.md). */
export class PokeClient {
  readonly baseUrl: string;
  #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#headers = options.headers ?? {};
  }

  get token(): string | undefined {
    return this.#token;
  }
  setToken(token: string | undefined): void {
    this.#token = token;
  }

  /** Headers an image loader needs for authenticated URLs (attachments, image proxy). */
  authHeaders(): Record<string, string> {
    return { ...this.#headers, ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}) };
  }

  url(path: string, query?: Query): string {
    const q = query
      ? Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join("&")
      : "";
    return `${this.baseUrl}${path}${q ? `?${q}` : ""}`;
  }

  async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Query; form?: FormData; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(this.url(path, options.query), {
        method,
        headers: {
          ...this.authHeaders(),
          ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
          accept: "application/json",
          ...options.headers,
        },
        ...(options.form
          ? { body: options.form }
          : options.body !== undefined
            ? { body: JSON.stringify(options.body) }
            : {}),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new PokeError(
        aborted ? "Poke took too long to answer" : "Can't reach Poke",
        0,
        aborted ? "timeout" : "offline",
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const data: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const body = (data ?? {}) as { error?: { code?: string; message?: string } };
      throw new PokeError(
        body.error?.message ?? `Poke answered ${res.status}`,
        res.status,
        body.error?.code ?? "error",
      );
    }
    return data as T;
  }

  // ── core ─────────────────────────────────────────────────────────────────────────────────
  health() {
    return this.request<{ ok: boolean; version: string; protocol: number }>("GET", "/v1/health");
  }
  pair(body: PairRequest) {
    return this.request<{ token: string; device: Device }>("POST", "/v1/pair", { body });
  }
  devices() {
    return this.request<{ devices: Device[] }>("GET", "/v1/devices");
  }
  removeDevice(id: string) {
    return this.request<unknown>("DELETE", `/v1/devices/${enc(id)}`);
  }
  shareToken() {
    return this.request<{ token: string; device: Device }>("POST", "/v1/devices/share-token");
  }

  // ── thread ───────────────────────────────────────────────────────────────────────────────
  thread() {
    return this.request<ThreadInfo>("GET", "/v1/thread");
  }
  messages(query: { before?: string; limit?: number; around?: string } = {}) {
    return this.request<ThreadPage>("GET", "/v1/thread/messages", { query });
  }
  send(body: SendMessageRequest) {
    return this.request<{ message: Message; duplicate: boolean }>("POST", "/v1/thread/messages", { body });
  }
  message(id: string) {
    return this.request<{ message: Message; blocks: Block[]; traces: Trace[] }>(
      "GET",
      `/v1/messages/${enc(id)}`,
    );
  }
  trace(id: string) {
    return this.request<{ trace: Trace; steps: Step[]; tasks: Task[] }>("GET", `/v1/traces/${enc(id)}`);
  }
  /** The composer's stop: ends Poke's turn and the agents it started. */
  stop() {
    return this.request<{ stopped: boolean; tasks: number }>("POST", "/v1/thread/stop");
  }

  // ── settings and voice (milestone 10) ──────────────────────────────────────────────────────
  settings() {
    return this.request<{ settings: AppSettings }>("GET", "/v1/settings");
  }
  updateSettings(patch: AppSettingsPatch) {
    return this.request<{ settings: AppSettings }>("PATCH", "/v1/settings", { body: patch });
  }
  voice() {
    return this.request<VoiceInfo>("GET", "/v1/voice");
  }
  /** A message read aloud: WAV bytes (the server caches them per message and voice). */
  async tts(messageId: string, voice?: string): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await this.#fetch(this.url("/v1/tts"), {
        method: "POST",
        headers: { ...this.authHeaders(), "content-type": "application/json", accept: "audio/wav" },
        body: JSON.stringify({ messageId, ...(voice ? { voice } : {}) }),
      });
    } catch {
      throw new PokeError("Can't reach Poke", 0, "offline");
    }
    if (!res.ok) {
      const body = safeJson(await res.text()) as { error?: { code?: string; message?: string } };
      throw new PokeError(
        body.error?.message ?? `Poke answered ${res.status}`,
        res.status,
        body.error?.code ?? "error",
      );
    }
    return res.arrayBuffer();
  }
  /**
   * Where a voice socket connects (/v1/voice/dictate or /v1/voice/call) and how it authenticates:
   * the token rides in the subprotocol, like the event stream.
   */
  socketTarget(path: "/v1/voice/dictate" | "/v1/voice/call") {
    return {
      url: `${this.baseUrl.replace(/^http/, "ws")}${path}`,
      protocols: ["poke.v1", `poke.bearer.${this.#token ?? ""}`],
      headers: { ...this.#headers },
    };
  }
  search(q: string, filter: "all" | "messages" | "tasks" | "links" | "photos" = "all") {
    return this.request<SearchResponse>("GET", "/v1/search", { query: { q, filter } });
  }
  upload(form: FormData) {
    return this.request<{ attachment: Attachment }>("POST", "/v1/attachments", { form });
  }
  attachmentUrl(id: string): string {
    return this.url(`/v1/attachments/${enc(id)}`);
  }
  /** Card images and logos load through Poke, never straight from the third party. */
  imageUrl(src: string): string {
    return this.url("/v1/images", { src });
  }
  logoUrl(domain: string): string {
    return this.url(`/v1/logos/${enc(domain)}`);
  }

  // ── blocks ───────────────────────────────────────────────────────────────────────────────
  block(id: string) {
    return this.request<{ block: Block }>("GET", `/v1/blocks/${enc(id)}`);
  }
  act(id: string, body: BlockActionRequest) {
    return this.request<{ block: Block; result?: Record<string, unknown> }>(
      "POST",
      `/v1/blocks/${enc(id)}/actions`,
      { body },
    );
  }

  // ── agents ───────────────────────────────────────────────────────────────────────────────
  tasks(all = false) {
    return this.request<{ tasks: Task[] }>("GET", "/v1/tasks", { query: { all: all ? "true" : undefined } });
  }
  cancelTask(id: string) {
    return this.request<unknown>("POST", `/v1/tasks/${enc(id)}/cancel`);
  }
  context() {
    return this.request<Record<string, unknown>>("GET", "/v1/context");
  }
  compact() {
    return this.request<unknown>("POST", "/v1/context/compact");
  }
  sideChats() {
    return this.request<{ sideChats: SideChatView[] }>("GET", "/v1/sidechats");
  }
  openSideChat() {
    return this.request<{ sideChat: SideChatView }>("POST", "/v1/sidechats");
  }
  sideChat(id: string) {
    return this.request<{ sideChat: SideChatView }>("GET", `/v1/sidechats/${enc(id)}`);
  }
  sendSideChat(id: string, text: string) {
    return this.request<{ message: Message }>("POST", `/v1/sidechats/${enc(id)}/messages`, {
      body: { text },
    });
  }
  cancelSideChat(id: string) {
    return this.request<unknown>("POST", `/v1/sidechats/${enc(id)}/cancel`);
  }
  sendSideChatToPoke(id: string) {
    return this.request<{ message: Message }>("POST", `/v1/sidechats/${enc(id)}/send-to-poke`);
  }
  closeSideChat(id: string) {
    return this.request<unknown>("DELETE", `/v1/sidechats/${enc(id)}`);
  }

  // ── vault: each call carries a fresh proof, signed after Face ID (X-Poke-Vault-Proof) ──
  vaultChallenge(action: VaultAction, name?: string) {
    return this.request<VaultChallenge>("POST", "/v1/vault/challenge", {
      body: { action, ...(name ? { name } : {}) },
    });
  }
  vault(proof: string) {
    return this.request<{ entries: VaultEntry[] }>("GET", "/v1/vault", { headers: proofHeader(proof) });
  }
  addVaultEntry(body: VaultAddBody, proof: string) {
    return this.request<{ entry: VaultEntry }>("POST", "/v1/vault/entries", {
      body,
      headers: proofHeader(proof),
    });
  }
  editVaultEntry(name: string, body: Partial<Omit<VaultAddBody, "name" | "kind">>, proof: string) {
    return this.request<{ entry: VaultEntry }>("PATCH", `/v1/vault/entries/${enc(name)}`, {
      body,
      headers: proofHeader(proof),
    });
  }
  deleteVaultEntry(name: string, proof: string) {
    return this.request<unknown>("DELETE", `/v1/vault/entries/${enc(name)}`, { headers: proofHeader(proof) });
  }
  revealVaultEntry(name: string, proof: string) {
    return this.request<{ secrets: Record<string, string> }>(
      "POST",
      `/v1/vault/entries/${enc(name)}/reveal`,
      {
        headers: proofHeader(proof),
      },
    );
  }

  // ── approvals ────────────────────────────────────────────────────────────────────────────
  approvalRules() {
    return this.request<{ rules: ApprovalRule[] }>("GET", "/v1/approvals/rules");
  }
  deleteApprovalRule(id: string) {
    return this.request<unknown>("DELETE", `/v1/approvals/rules/${enc(id)}`);
  }

  // ── integrations ─────────────────────────────────────────────────────────────────────────
  integrations() {
    return this.request<{ integrations: Integration[]; executor: { configured: boolean } }>(
      "GET",
      "/v1/integrations",
    );
  }
  catalog() {
    return this.request<{ apps: CatalogApp[] }>("GET", "/v1/integrations/catalog");
  }
  connect(appId: string) {
    return this.request<{ url: string }>("POST", `/v1/integrations/${enc(appId)}/connect`);
  }
  updateIntegration(appId: string, body: IntegrationPatchRequest) {
    return this.request<{ integration: Integration }>("PATCH", `/v1/integrations/${enc(appId)}`, { body });
  }
  disconnect(appId: string, accountId: string) {
    return this.request<unknown>("DELETE", `/v1/integrations/${enc(appId)}/accounts/${enc(accountId)}`);
  }
  mcpServers() {
    return this.request<{ servers: McpServer[] }>("GET", "/v1/integrations/mcp");
  }
  addMcpServer(body: { id: string; name?: string; transport: McpServer["transport"] }) {
    return this.request<{ server: McpServer }>("POST", "/v1/integrations/mcp", { body });
  }
  removeMcpServer(id: string) {
    return this.request<unknown>("DELETE", `/v1/integrations/mcp/${enc(id)}`);
  }

  // ── routines & skills ────────────────────────────────────────────────────────────────────
  routines() {
    return this.request<{ routines: RoutineView[] }>("GET", "/v1/routines");
  }
  routine(id: string) {
    return this.request<{ routine: RoutineView; runs: RoutineRun[] }>("GET", `/v1/routines/${enc(id)}`);
  }
  updateRoutine(id: string, body: RoutinePatchRequest) {
    return this.request<{ routine: RoutineView }>("PATCH", `/v1/routines/${enc(id)}`, { body });
  }
  deleteRoutine(id: string) {
    return this.request<unknown>("DELETE", `/v1/routines/${enc(id)}`);
  }
  runRoutine(id: string) {
    return this.request<{ run: RoutineRun }>("POST", `/v1/routines/${enc(id)}/run`);
  }
  skills() {
    return this.request<{ skills: Skill[] }>("GET", "/v1/skills");
  }
  skill(name: string) {
    return this.request<{ skill: Skill & { body?: string } }>("GET", `/v1/skills/${enc(name)}`);
  }
  setSkillEnabled(name: string, enabled: boolean) {
    return this.request<{ skill: Skill }>("PATCH", `/v1/skills/${enc(name)}`, { body: { enabled } });
  }
  deleteSkill(name: string) {
    return this.request<unknown>("DELETE", `/v1/skills/${enc(name)}`);
  }

  // ── library ──────────────────────────────────────────────────────────────────────────────
  library(
    query: {
      filter?: "all" | "photos" | "files" | "from_poke";
      q?: string;
      before?: number;
      limit?: number;
    } = {},
  ) {
    return this.request<{ attachments: Attachment[] }>("GET", "/v1/library", {
      query: { filter: query.filter, q: query.q, before: query.before, limit: query.limit },
    });
  }
  workspace(path = "") {
    return this.request<WorkspaceListing>("GET", "/v1/library/workspace", { query: { path } });
  }
  workspaceFileUrl(path: string): string {
    return this.url("/v1/library/workspace/file", { path });
  }

  // ── memory ───────────────────────────────────────────────────────────────────────────────
  recall(q: string) {
    return this.request<{ answer: string }>("GET", "/v1/memory/recall", { query: { q } });
  }
}

/** Side chats live in memory on the server and vanish when closed. */
export interface SideChatView {
  id: string;
  model: string;
  messages: Message[];
  activity: "idle" | "thinking" | "working";
  createdAt: number;
}

export type VaultAction = "list" | "add" | "edit" | "delete" | "reveal";
export interface VaultChallenge {
  challengeId: string;
  nonce: string;
  expiresAt: number;
  /** Sign the UTF-8 bytes with the device's Ed25519 key; send `<challengeId>.<base64url signature>`. */
  message: string;
}
export interface VaultAddBody {
  name: string;
  kind: "login" | "api_key" | "card" | "code" | "note";
  fields?: Record<string, string>;
  secrets: Record<string, string>;
  description?: string;
}

function proofHeader(proof: string): Record<string, string> {
  return { "x-poke-vault-proof": proof };
}

const enc = encodeURIComponent;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 300) } };
  }
}
