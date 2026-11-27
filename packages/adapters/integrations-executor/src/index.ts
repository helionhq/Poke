import type {
  ExecutorCatalogApp,
  ExecutorMetaTool,
  ExecutorOutcome,
  ExecutorPort,
  Logger,
  McpCallResult,
  McpConnector,
  McpServerConfig,
  McpSession,
} from "@poke/domain";

export const EXECUTOR_ORIGIN = "https://mcp.executor.sh";
export const EXECUTOR_CATALOG_URL = "https://catalog.executor.sh/index.json";
const CALL_TIMEOUT_MS = 6 * 60_000; // execute runs up to 5 minutes, not counting approvals
const CATALOG_TTL_MS = 60 * 60_000;

/**
 * Always model mode (brief 3.7): with a token on the plain URL Executor approves gated calls by
 * itself. In model mode a gated call pauses and comes back as `approval-required`.
 */
export function executorUrl(org: string, origin = EXECUTOR_ORIGIN): string {
  return `${origin.replace(/\/+$/, "")}/org/${encodeURIComponent(org)}/mcp?elicitation_mode=model`;
}

export interface ExecutorClientOptions {
  connector: McpConnector;
  /** The personal access token, from the vault's system namespace. */
  token(): string | undefined;
  org(): string | undefined;
  origin?: string;
  catalogUrl?: string;
  fetch?: typeof globalThis.fetch;
  log: Logger;
  /** Tests: connect to this instead of Executor Cloud. */
  transport?: McpServerConfig["transport"];
}

/** Executor Cloud over MCP (section 11.1). One connection, reopened when the token or org changes. */
export class ExecutorClient implements ExecutorPort {
  #session?: { key: string; session: Promise<McpSession> };
  #catalog?: { at: number; apps: ExecutorCatalogApp[] };

  constructor(private readonly options: ExecutorClientOptions) {}

  configured(): boolean {
    return Boolean(this.options.transport ?? (this.options.token() && this.options.org()));
  }

  async run(
    tool: ExecutorMetaTool,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ExecutorOutcome> {
    return parseOutcome(await this.#call(tool, input, signal));
  }

  async resume(
    requestId: string,
    response: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<ExecutorOutcome> {
    const body =
      response.action === "accept" ? { action: "accept", content: response.content ?? {} } : response;
    return parseOutcome(await this.#call("resume", { requestId, response: body }, signal));
  }

  /**
   * Starts an account connection from a script, as the docs show. The response field that holds
   * the link isn't documented (docs/EXECUTOR-PROTOCOL.md), so the first https URL and the
   * connection id are looked up by their usual names.
   */
  async connect(app: string, requirement = "default"): Promise<{ url: string; connectionId: string }> {
    const org = this.options.org() ?? "";
    const code = [
      `return await tools.executor.appAccounts.userConnect({ path: { organization: ${JSON.stringify(org)},`,
      ` app: ${JSON.stringify(app)}, requirement: ${JSON.stringify(requirement)} } });`,
    ].join("");
    const outcome = await this.run("execute", { code });
    const result = completedResult(outcome, "start connecting");
    const url = findString(result, URL_KEYS, (v) => /^https:\/\//.test(v));
    const connectionId =
      findString(result, ["connectionId"], () => true) ??
      findString(pick(result, "connection"), ["id"], () => true) ??
      findString(result, ["connection", "id"], (v) => !/^https?:/.test(v));
    if (!url || !connectionId)
      throw new Error(`Executor's answer had no sign-in link (fields: ${describeKeys(result)})`);
    return { url, connectionId };
  }

  async connection(connectionId: string): Promise<{
    status: "pending" | "expired" | "cancelled" | "completed";
    account?: string;
  }> {
    const code = `return await tools.executor.accountConnections.get({ path: { connection: ${JSON.stringify(connectionId)} } });`;
    const result = completedResult(await this.run("execute", { code }), "check the connection");
    const state = (pick(result, "state") ?? pick(pick(result, "connection"), "state")) as
      { status?: unknown; account?: unknown } | undefined;
    const status = String(state?.status ?? "").toLowerCase();
    if (status !== "pending" && status !== "expired" && status !== "cancelled" && status !== "completed")
      throw new Error(`Executor sent an unknown connection state (${status || "none"})`);
    const account = state?.account as Record<string, unknown> | undefined;
    const label = account
      ? (findString(account, ["name", "label", "email", "identity"], () => true) ?? undefined)
      : undefined;
    return { status, ...(label ? { account: label } : {}) };
  }

  /** Executor's public app catalog, cached for an hour. */
  async catalog(): Promise<ExecutorCatalogApp[]> {
    const now = Date.now();
    if (this.#catalog && now - this.#catalog.at < CATALOG_TTL_MS) return this.#catalog.apps;
    const url = this.options.catalogUrl ?? EXECUTOR_CATALOG_URL;
    const response = await (this.options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`The app catalog answered ${response.status}`);
    const apps = parseCatalog(await response.json(), url);
    this.#catalog = { at: now, apps };
    return apps;
  }

  async close(): Promise<void> {
    const current = this.#session;
    this.#session = undefined;
    if (current) await (await current.session.catch(() => undefined))?.close().catch(() => {});
  }

  async #call(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const session = await this.#open();
    try {
      return await session.call(tool, input, { timeoutMs: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    } catch (error) {
      // A dropped session can't resume what it paused; the next call opens a new one.
      this.#session = undefined;
      throw error;
    }
  }

  #open(): Promise<McpSession> {
    const { transport, token, org, origin, connector, log } = this.options;
    const key = transport ? "test" : `${org() ?? ""}\n${token() ?? ""}`;
    if (this.#session?.key === key) return this.#session.session;
    const previous = this.#session;
    if (previous) void previous.session.then((s) => s.close()).catch(() => {});
    if (!transport && !(token() && org()))
      return Promise.reject(
        new Error(
          "Executor isn't set up yet. On your server, run `poke config executor.org` and `poke config executor.token`.",
        ),
      );
    const target: McpServerConfig["transport"] = transport ?? {
      kind: "http",
      url: executorUrl(org()!, origin),
      headers: { Authorization: `Bearer ${token()!}` },
    };
    const session = connector.connect(target, { name: "Executor" }).then((s) => {
      s.onClose(() => {
        if (this.#session?.session === session) this.#session = undefined;
        log.info("Executor connection closed");
      });
      return s;
    });
    session.catch(() => {
      if (this.#session?.session === session) this.#session = undefined;
    });
    this.#session = { key, session };
    return session;
  }
}

/** Executor's McpExecutionResult (and the plain results of search, describe, skills). */
export function parseOutcome(result: McpCallResult): ExecutorOutcome {
  const text = result.output
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n")
    .trim();
  if (result.isError) return { status: "other", text: text || "Executor reported an error", isError: true };
  let data = result.structured;
  if (data === undefined) {
    try {
      data = JSON.parse(text);
    } catch {
      return { status: "other", text, isError: false };
    }
  }
  const value = (data ?? {}) as Record<string, unknown>;
  switch (value.status) {
    case "completed": {
      const execution = value.execution ?? value;
      return { status: "completed", result: execution, text: JSON.stringify(execution) };
    }
    case "approval-required": {
      const invocation = (value.invocation ?? {}) as Record<string, unknown>;
      const elicitation = (value.elicitation ?? {}) as Record<string, unknown>;
      const kind =
        invocation.kind === "query" || invocation.kind === "mutation" ? invocation.kind : undefined;
      return {
        status: "approval-required",
        requestId: String(value.requestId ?? ""),
        app: String(invocation.app ?? "executor"),
        tool: String(invocation.tool ?? "tool"),
        ...(kind ? { kind } : {}),
        input: isRecord(invocation.input) ? invocation.input : {},
        message: String(elicitation.message ?? ""),
        ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
      };
    }
    case "input-required": {
      const tool = (value.tool ?? {}) as Record<string, unknown>;
      const elicitation = (value.elicitation ?? {}) as Record<string, unknown>;
      return {
        status: "input-required",
        requestId: String(value.requestId ?? ""),
        app: String(tool.app ?? "executor"),
        tool: String(tool.tool ?? "tool"),
        message: String(elicitation.message ?? ""),
        ...(isRecord(elicitation.requestedSchema) ? { schema: elicitation.requestedSchema } : {}),
        ...(typeof value.expiresAt === "number" ? { expiresAt: value.expiresAt } : {}),
      };
    }
    case "unavailable":
      return {
        status: "unavailable",
        ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
        reason: String(value.reason ?? "unknown"),
        message: String(value.message ?? "That request is no longer available."),
      };
    case "busy":
    case "capacity-exceeded":
      return { status: "other", text: text || String(value.status), isError: true };
    default:
      // search, describe and skills answer with their own result objects.
      return { status: "completed", result: data, text: text || JSON.stringify(data) };
  }
}

export function parseCatalog(feed: unknown, feedUrl: string): ExecutorCatalogApp[] {
  const apps = isRecord(feed) && Array.isArray(feed.apps) ? feed.apps : [];
  const out: ExecutorCatalogApp[] = [];
  for (const raw of apps) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") continue;
    const icons = Array.isArray(raw.icons) ? raw.icons.filter(isRecord) : [];
    const icon = icons.find((i) => i.theme !== "dark") ?? icons[0];
    let iconUrl: string | undefined;
    if (icon && typeof icon.src === "string") {
      try {
        iconUrl = new URL(icon.src, feedUrl).toString();
      } catch {
        iconUrl = undefined;
      }
    }
    out.push({
      id: raw.id,
      name: raw.name,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.category === "string" ? { category: raw.category } : {}),
      ...(iconUrl ? { icon: iconUrl } : {}),
      auth: (Array.isArray(raw.auth) ? raw.auth.filter(isRecord) : []).map((a) => ({
        method: String(a.method ?? ""),
        kind: String(a.kind ?? ""),
        ...(typeof a.label === "string" ? { label: a.label } : {}),
      })),
    });
  }
  return out;
}

const URL_KEYS = ["url", "connectUrl", "connectionUrl", "link", "href", "authorizationUrl", "signInUrl"];

function completedResult(outcome: ExecutorOutcome, what: string): unknown {
  if (outcome.status !== "completed")
    throw new Error(
      `Executor couldn't ${what}: ${outcome.status === "other" || outcome.status === "unavailable" ? (outcome.status === "other" ? outcome.text : outcome.message) : outcome.status}`,
    );
  const execution = outcome.result as Record<string, unknown> | undefined;
  return execution && "result" in execution ? execution.result : execution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Breadth-first: the shallowest string under one of `keys` that passes `ok`. */
function findString(value: unknown, keys: string[], ok: (v: string) => boolean): string | undefined {
  const queue: unknown[] = [value];
  for (let seen = 0; queue.length && seen < 200; seen++) {
    const current = queue.shift();
    if (!isRecord(current)) {
      if (Array.isArray(current)) queue.push(...current);
      continue;
    }
    for (const key of keys) {
      const found = current[key];
      if (typeof found === "string" && ok(found)) return found;
    }
    queue.push(...Object.values(current));
  }
  return undefined;
}

function describeKeys(value: unknown): string {
  return isRecord(value) ? Object.keys(value).join(", ") || "none" : typeof value;
}
