import { INTEGRATION_TOOLS } from "@poke/agent-core";
import {
  type Clock,
  DomainError,
  type ExecutorCatalogApp,
  type ExecutorOutcome,
  type ExecutorPort,
  type Integration,
  type Logger,
  type McpConnector,
  type McpServerConfig,
  type McpSession,
  type McpToolInfo,
  type Repositories,
  type SearchPort,
  type Timers,
  type ToolCallContext,
  type ToolResultData,
  type ToolSpec,
  type VaultPort,
} from "@poke/domain";
import { type ApprovalInput, type ApprovalOutcome, type ApprovalService, approvalKey } from "./approvals.js";
import type { BlockService, ConnectionStarter } from "./blocks.js";
import { handler, json, text, type ToolGateway } from "./tools/gateway.js";
import type { SecretResolver } from "./tools/secrets.js";
import type { EventHub } from "./core/hub.js";

/** browse's own MCP server (`browse mcp`), with a reader for its `status` result. */
export interface BrowseBridge {
  transport: McpServerConfig["transport"];
  parseStatus(text: string): { connected: boolean; nextStep?: string };
}

export interface IntegrationsDeps {
  repos: Repositories;
  clock: Clock;
  timers: Timers;
  log: Logger;
  gateway: ToolGateway;
  approvals: Pick<ApprovalService, "gate" | "allowEdited">;
  executor: ExecutorPort;
  search: SearchPort;
  vault: Pick<VaultPort, "list">;
  mcp: McpConnector;
  resolver: SecretResolver;
  browse?: BrowseBridge;
  /** Publishes integration.updated so the app refreshes its lists. */
  hub?: EventHub;
}

/** The read-only Executor tools share one handler shape. */
type ReadOnlyDefinition = { spec: ToolSpec; parse(args: unknown): Record<string, unknown> };

const CONNECT_POLL_MS = 3_000;
/** Executor drops a pending connection after 30 minutes. */
const CONNECT_DEADLINE_MS = 30 * 60_000;
const MCP_RECONNECT_MS = 30_000;
const MCP_RETRY_MAX_MS = 10 * 60_000;
const BROWSE_ID = "browse";

interface LiveServer {
  config: McpServerConfig;
  session?: McpSession;
  tools: string[];
  error?: string;
  retry?: { cancel(): void };
}

/**
 * Integrations (section 11): Keenable web tools, the Executor bridge with its approvals and
 * sign-ins, local MCP servers and browse. Every call goes through the ToolGateway, so vault
 * placeholders and redaction apply; nothing here asks for an OK unless Executor paused the call.
 */
export class IntegrationService implements ConnectionStarter {
  readonly #servers = new Map<string, LiveServer>();
  readonly #polls = new Map<string, { cancel(): void }>();
  #blocks?: Pick<BlockService, "system">;
  #closed = false;

  constructor(private readonly deps: IntegrationsDeps) {
    this.#registerTools();
  }

  /** BlockService is built after this (it takes this as its ConnectionStarter). */
  attachBlocks(blocks: Pick<BlockService, "system">): void {
    this.#blocks = blocks;
  }

  /** Connect browse and every enabled MCP server. Failures are logged, never fatal. */
  async connectAll(): Promise<void> {
    const work: Array<Promise<unknown>> = [];
    if (this.deps.browse) {
      const browse: McpServerConfig = {
        id: BROWSE_ID,
        name: "Your browser",
        transport: this.deps.browse.transport,
        enabled: true,
        createdAt: 0,
      };
      work.push(this.#connect(browse));
    }
    for (const server of this.deps.repos.integrations.mcpServers())
      if (server.enabled) work.push(this.#connect(server));
    await Promise.all(work);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const poll of this.#polls.values()) poll.cancel();
    this.#polls.clear();
    await Promise.all(
      [...this.#servers.values()].map(async (server) => {
        server.retry?.cancel();
        await server.session?.close().catch(() => {});
      }),
    );
    await this.deps.executor.close().catch(() => {});
  }

  // ── local MCP servers ──────────────────────────────────────────────────────────────────────

  mcpServers(): Array<McpServerConfig & { connected: boolean; error?: string }> {
    return this.deps.repos.integrations.mcpServers().map((config) => {
      const live = this.#servers.get(config.id);
      return { ...config, connected: Boolean(live?.session), ...(live?.error ? { error: live.error } : {}) };
    });
  }

  async addMcpServer(input: {
    id: string;
    name?: string;
    transport: McpServerConfig["transport"];
  }): Promise<McpServerConfig & { connected: boolean; error?: string }> {
    if (input.id === BROWSE_ID) throw new DomainError("conflict", "browse is built in");
    if (this.deps.repos.integrations.mcpServers().some((s) => s.id === input.id))
      throw new DomainError("conflict", `There's already a server called ${input.id}`);
    const config: McpServerConfig = {
      id: input.id,
      name: input.name ?? input.id,
      transport: input.transport,
      enabled: true,
      createdAt: this.deps.clock.now(),
    };
    this.deps.repos.integrations.saveMcpServer(config);
    await this.#connect(config);
    const saved = this.mcpServers().find((s) => s.id === config.id)!;
    return saved;
  }

  async removeMcpServer(id: string): Promise<boolean> {
    const removed = this.deps.repos.integrations.deleteMcpServer(id);
    await this.#disconnect(id);
    return removed;
  }

  /** `failures`: failed attempts in a row before this one (the retry waits longer each time). */
  async #connect(config: McpServerConfig, failures = 0): Promise<void> {
    await this.#disconnect(config.id);
    const live: LiveServer = { config, tools: [] };
    this.#servers.set(config.id, live);
    let release = () => {};
    try {
      // Headers and env may carry {{vault:…}} placeholders; they are filled in only here.
      const prepared = this.deps.resolver.prepare(
        `mcp:${config.id}`,
        config.transport,
        { kind: "poke" },
        `mcp:${config.id}`,
      );
      release = prepared.release;
      const session = await this.deps.mcp.connect(prepared.args as McpServerConfig["transport"], {
        name: config.name,
      });
      if (this.#closed || this.#servers.get(config.id) !== live) {
        await session.close().catch(() => {});
        return;
      }
      live.session = session;
      const tools = await session.tools();
      for (const tool of tools) live.tools.push(this.#registerMcpTool(live, tool));
      if (config.id !== BROWSE_ID) {
        this.deps.repos.integrations.saveMcpServer({ ...config, toolCount: tools.length });
        live.config = { ...config, toolCount: tools.length };
      }
      session.onClose(() => {
        if (this.#servers.get(config.id) !== live || this.#closed) return;
        this.#unregister(live);
        live.session = undefined;
        live.error = "disconnected";
        this.deps.log.warn({ server: config.id }, "MCP server disconnected");
        live.retry = this.deps.timers.setTimeout(() => void this.#connect(live.config), MCP_RECONNECT_MS);
      });
      this.deps.log.info({ server: config.id, tools: tools.length }, "MCP server connected");
    } catch (error) {
      live.error = this.deps.gateway.interceptor.redact(errorText(error));
      this.deps.log.info({ server: config.id, error: live.error }, "MCP server unavailable");
      // A server that starts after Poke (or a missing vault entry he adds later) gets more tries.
      if (!this.#closed && this.#servers.get(config.id) === live) {
        const wait = Math.min(MCP_RECONNECT_MS * 2 ** failures, MCP_RETRY_MAX_MS);
        live.retry = this.deps.timers.setTimeout(() => void this.#connect(live.config, failures + 1), wait);
      }
    } finally {
      release();
    }
  }

  async #disconnect(id: string): Promise<void> {
    const live = this.#servers.get(id);
    if (!live) return;
    this.#servers.delete(id);
    live.retry?.cancel();
    this.#unregister(live);
    await live.session?.close().catch(() => {});
  }

  #unregister(live: LiveServer): void {
    for (const name of live.tools) this.deps.gateway.unregister(name);
    live.tools = [];
  }

  #registerMcpTool(live: LiveServer, tool: McpToolInfo): string {
    const isBrowse = live.config.id === BROWSE_ID;
    const name = toolName(isBrowse ? `browse_${tool.name}` : `mcp__${live.config.id}__${tool.name}`);
    const summary = firstLine(tool.description ?? tool.title ?? tool.name);
    const spec: ToolSpec = {
      name,
      description: isBrowse
        ? `Arham's own browser (logged in, his tabs): ${summary}`
        : `${live.config.name}: ${summary}`,
      inputSchema: tool.inputSchema,
      loading: "deferred",
      callers: ["model"],
      replay: tool.annotations?.readOnlyHint ? "safe" : "unsafe",
      namespace: live.config.id,
      searchHint: isBrowse ? "browser chrome web page click login" : live.config.name,
    };
    const parse = (args: unknown) =>
      args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    this.deps.gateway.register(
      handler({ spec, parse }, async (args, ctx) => {
        const session = live.session;
        if (!session) return text(`${live.config.name} isn't connected right now.`, true);
        if (isBrowse && tool.name !== "status") {
          const unavailable = await this.#browserUnavailable(session);
          if (unavailable) return unavailable;
        }
        const result = await session.call(tool.name, args, { signal: ctx.signal });
        return {
          output: result.output,
          ...(result.isError ? { isError: true } : {}),
          ...(result.structured !== undefined ? { structured: result.structured } : {}),
        };
      }),
      ["executor", "sidechat"],
      { resolveSecrets: true, usedBy: isBrowse ? "Your browser" : live.config.name },
    );
    return name;
  }

  /** Section 11.3: check `status` first, and say so plainly when the laptop is asleep. */
  async #browserUnavailable(session: McpSession): Promise<ToolResultData | undefined> {
    const browse = this.deps.browse;
    if (!browse) return undefined;
    try {
      const status = await session.call("status", {}, { timeoutMs: 10_000 });
      const textOut = status.output.map((o) => (o.type === "text" ? o.text : "")).join("");
      const parsed = browse.parseStatus(textOut);
      if (parsed.connected) return undefined;
      return text(
        `Arham's browser isn't connected right now (his laptop may be asleep or Chrome closed)${parsed.nextStep ? `: ${parsed.nextStep}` : "."} Report that; don't retry until he says it's back.`,
        true,
      );
    } catch {
      return undefined;
    }
  }

  // ── Executor sign-ins (ConnectionStarter) ──────────────────────────────────────────────────

  /** The `connect` action on a connect_request block: start the sign-in, then watch it. */
  async start(input: { app: string; kind: "app" | "custom"; blockId?: string }): Promise<{ url: string }> {
    const { executor } = this.deps;
    if (!executor.configured())
      throw new DomainError(
        "unavailable",
        "Executor isn't set up yet. On your server, run `poke config executor.org` and `poke config executor.token`.",
      );
    const { url, connectionId } = await executor.connect(input.app);
    const key = input.blockId ?? `app:${input.app}`;
    this.#polls.get(key)?.cancel();
    const deadline = this.deps.clock.now() + CONNECT_DEADLINE_MS;
    const poll = () => {
      const timer = this.deps.timers.setTimeout(() => {
        void this.#checkConnection(input, connectionId, deadline, poll);
      }, CONNECT_POLL_MS);
      this.#polls.set(key, timer);
    };
    poll();
    return { url };
  }

  async #checkConnection(
    input: { app: string; blockId?: string },
    connectionId: string,
    deadline: number,
    again: () => void,
  ): Promise<void> {
    if (this.#closed) return;
    const key = input.blockId ?? `app:${input.app}`;
    const fail = async (error: string) => {
      this.#polls.delete(key);
      if (input.blockId) await this.#blocks?.system(input.blockId, "failed", { error });
      else this.#changed(input.app);
    };
    try {
      const state = await this.deps.executor.connection(connectionId);
      if (state.status === "completed") {
        this.#polls.delete(key);
        this.#saveAccount(input.app, connectionId, state.account);
        this.#changed(input.app);
        if (input.blockId)
          await this.#blocks?.system(input.blockId, "connected", {
            connectionId,
            ...(state.account ? { account: state.account.slice(0, 200) } : {}),
          });
        return;
      }
      if (state.status !== "pending") return void (await fail("The sign-in didn't finish"));
    } catch (error) {
      this.deps.log.info({ error: errorText(error) }, "couldn't check a connection yet");
    }
    if (this.deps.clock.now() >= deadline) return void (await fail("The sign-in timed out"));
    again();
  }

  /** Removes one account from Poke's list (the app's own connection stays in Executor). */
  disconnect(appId: string, accountId: string): void {
    const existing = this.#integration(appId);
    const accounts = existing.accounts.filter((a) => a.id !== accountId);
    if (accounts.length === existing.accounts.length)
      throw new DomainError("not_found", "That account isn't connected");
    if (accounts.length === 0) this.deps.repos.integrations.delete(appId);
    else
      this.deps.repos.integrations.save({
        ...existing,
        accounts,
        ...(existing.defaultAccountId === accountId ? { defaultAccountId: accounts[0]!.id } : {}),
      });
    this.#changed(appId);
  }

  /** Which account Poke uses for an app when a task doesn't name one. */
  setDefaultAccount(appId: string, accountId: string): Integration {
    const existing = this.#integration(appId);
    if (!existing.accounts.some((a) => a.id === accountId))
      throw new DomainError("not_found", "That account isn't connected");
    const next = { ...existing, defaultAccountId: accountId };
    this.deps.repos.integrations.save(next);
    this.#changed(appId);
    return next;
  }

  /** Poke's own on/off switch for a capability. "ask" belongs to Executor and can't be set here. */
  setCapability(appId: string, capabilityId: string, mode: "on" | "off"): Integration {
    const existing = this.#integration(appId);
    const cap = existing.capabilities.find((c) => c.id === capabilityId);
    if (!cap) throw new DomainError("not_found", "That capability doesn't exist");
    if (cap.mode === "ask")
      throw new DomainError("invalid", "This one asks first in Executor; change it there");
    const next = {
      ...existing,
      capabilities: existing.capabilities.map((c) => (c.id === capabilityId ? { ...c, mode } : c)),
    };
    this.deps.repos.integrations.save(next);
    this.#changed(appId);
    return next;
  }

  #integration(appId: string): Integration {
    const existing = this.deps.repos.integrations.get(appId);
    if (!existing) throw new DomainError("not_found", `${appId} isn't connected`);
    return existing;
  }

  #changed(appId: string): void {
    this.deps.hub?.publish(() => [{ type: "integration.updated", integrationId: appId }]);
  }

  #saveAccount(app: string, connectionId: string, account?: string): void {
    const existing = this.deps.repos.integrations.get(app);
    const now = this.deps.clock.now();
    const entry = {
      id: connectionId,
      appId: app,
      label: account ?? titleCase(app),
      ...(account ? { identity: account } : {}),
      status: "connected" as const,
    };
    const integration: Integration = existing
      ? {
          ...existing,
          accounts: [...existing.accounts.filter((a) => a.id !== connectionId), entry],
          connectedAt: existing.connectedAt ?? now,
        }
      : {
          id: app,
          name: titleCase(app),
          source: "executor",
          accounts: [entry],
          defaultAccountId: connectionId,
          capabilities: [],
          connectedAt: now,
        };
    this.deps.repos.integrations.save(integration);
  }

  catalog(): Promise<ExecutorCatalogApp[]> {
    return this.deps.executor.catalog();
  }

  // ── tools ──────────────────────────────────────────────────────────────────────────────────

  #registerTools(): void {
    const { gateway, search, vault, executor } = this.deps;
    const T = INTEGRATION_TOOLS;
    gateway.register(
      handler(T.searchWeb, async (args) => {
        const out = await search.search(args);
        return { ...text(out.text), details: { results: out.results } };
      }),
      ["poke", "executor", "sidechat"],
    );
    gateway.register(
      handler(T.fetchPages, async (args) => {
        const out = await search.fetch(args);
        return { ...text(out.text), details: { pages: out.pages } };
      }),
      ["poke", "executor", "sidechat"],
    );
    gateway.register(
      handler(T.vaultList, (args) => {
        const query = args.query?.toLowerCase();
        const entries = vault
          .list()
          .filter((e) => !query || `${e.name} ${e.description ?? ""}`.toLowerCase().includes(query))
          .map((e) => ({
            name: e.name,
            kind: e.kind,
            fields: e.fields,
            placeholders: e.secretFields.map((f) => `{{vault:${e.name}.${f}}}`),
            ...(e.description ? { description: e.description } : {}),
            ...(e.usedBy.length ? { usedBy: e.usedBy } : {}),
            ...(e.ephemeral ? { oneTime: true } : {}),
          }));
        return entries.length ? json(entries) : text("Nothing saved yet.");
      }),
      ["poke", "executor", "sidechat"],
    );

    const notSetUp = () =>
      text("Executor isn't set up, so apps aren't available. Say so in your report.", true);
    for (const [definition, tool] of [
      [T.executorSkills, "skills"],
      [T.executorSearch, "search"],
      [T.executorDescribe, "describe"],
    ] as const) {
      gateway.register(
        handler(definition as ReadOnlyDefinition, async (args, ctx) => {
          if (!executor.configured()) return notSetUp();
          return this.#settle(ctx, await executor.run(tool, args, ctx.signal));
        }),
        ["executor", "sidechat"],
      );
    }
    gateway.register(
      handler(T.executorCall, (args, ctx) =>
        this.#gated(ctx, args.intent, () =>
          executor.run("call", { calls: args.calls } as Record<string, unknown>, ctx.signal),
        ),
      ),
      ["executor", "sidechat"],
      { resolveSecrets: true, usedBy: "Executor" },
    );
    gateway.register(
      handler(T.executorExecute, (args, ctx) =>
        this.#gated(ctx, args.intent, () => executor.run("execute", { code: args.code }, ctx.signal)),
      ),
      ["executor", "sidechat"],
      { resolveSecrets: true, usedBy: "Executor" },
    );
    gateway.register(
      handler(T.executorResume, (args, ctx) =>
        this.#gated(ctx, undefined, () =>
          executor.resume(
            args.requestId,
            { action: args.action, ...(args.content ? { content: args.content } : {}) },
            ctx.signal,
          ),
        ),
      ),
      ["executor", "sidechat"],
      { resolveSecrets: true, usedBy: "Executor" },
    );
    gateway.register(
      handler(T.addMcpServer, async (args) => {
        const transport: McpServerConfig["transport"] = args.url
          ? { kind: "http", url: args.url, ...(args.headers ? { headers: args.headers } : {}) }
          : {
              kind: "stdio",
              command: args.command!,
              args: args.args ?? [],
              ...(args.env ? { env: args.env } : {}),
            };
        const server = await this.addMcpServer({ id: args.name, transport });
        return server.connected
          ? text(
              `Added ${server.name} with ${server.toolCount ?? 0} tools. Agents started from now on can use them.`,
            )
          : text(`Saved ${server.name}, but it didn't connect: ${server.error ?? "unknown error"}`, true);
      }),
      ["poke"],
    );
  }

  async #gated(
    ctx: ToolCallContext,
    intent: string | undefined,
    first: () => Promise<ExecutorOutcome>,
  ): Promise<ToolResultData> {
    if (ctx.resume) return this.deps.approvals.gate(ctx, undefined, (o) => this.#afterDecision(ctx, o));
    if (!this.deps.executor.configured())
      return text("Executor isn't set up, so apps aren't available. Say so in your report.", true);
    return this.#settle(ctx, await first(), intent);
  }

  /** Turn Executor's answer into a tool result; a paused call goes to ApprovalService. */
  async #settle(ctx: ToolCallContext, outcome: ExecutorOutcome, intent?: string): Promise<ToolResultData> {
    switch (outcome.status) {
      case "completed":
        return { ...text(outcome.text), structured: outcome.result };
      case "approval-required": {
        const { resume: _resume, ...base } = ctx;
        const input = gatedInput(outcome, intent);
        const tag = outcome.requestId.replace(/[^A-Za-z0-9]/g, "").slice(-12);
        return this.deps.approvals.gate({ ...base, callId: `${ctx.callId}_${tag}` }, input, (o) =>
          this.#afterDecision(base, o, intent),
        );
      }
      case "input-required":
        return text(
          [
            `${titleCase(outcome.app)} needs more input for ${outcome.tool}: ${outcome.message}`,
            `requestId: ${outcome.requestId}`,
            outcome.schema ? `fields: ${JSON.stringify(outcome.schema)}` : "",
            "Answer with executor_resume. If only Arham knows the answer, ask Poke first (ask_poke, kind question).",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      case "unavailable":
        return text(outcome.message, true);
      case "other":
        return text(outcome.text, outcome.isError);
    }
  }

  async #afterDecision(ctx: ToolCallContext, o: ApprovalOutcome, intent?: string): Promise<ToolResultData> {
    const { executor, approvals, repos } = this.deps;
    const requestId = o.executionId;
    if (!requestId) return text("That approval can't be found any more. Report what's blocked.", true);
    const { resume: _resume, ...base } = ctx;
    if (o.allowed && o.final) {
      // Executor resumes a call only as it was asked; an edited draft is sent as a new call.
      await executor.resume(requestId, { action: "decline" }).catch(() => undefined);
      const request = repos.approvals.get(o.approvalId);
      const original = (request?.presentation?.props ?? {}) as Record<string, unknown>;
      const changed = Object.entries(o.final).filter(([key, value]) => original[key] !== value);
      const key = approvalKey(ctx.agent);
      if (request && key)
        approvals.allowEdited(
          key,
          request.integration,
          request.tool,
          changed.map(([, value]) => String(value)),
        );
      return text(
        `Arham edited it before sending, so the original wasn't sent. Make the same call again with exactly these values; it goes through without asking again: ${JSON.stringify(o.final)}`,
      );
    }
    if (!o.allowed) {
      await executor.resume(requestId, { action: "decline" }).catch(() => undefined);
      return text(
        `Arham said no${o.note ? `: "${o.note}"` : ""}. It wasn't done. Don't retry it; report back${o.note ? " with what he asked for" : ""}.`,
      );
    }
    return this.#settle(base, await executor.resume(requestId, { action: "accept" }), intent);
  }
}

/** How a paused call is shown (section 12.1): a send as a draft, a booking or purchase as an action card. */
export function gatedInput(
  outcome: Extract<ExecutorOutcome, { status: "approval-required" }>,
  intent?: string,
): ApprovalInput {
  const appName = titleCase(outcome.app);
  const words = toolWords(outcome.tool);
  const details = flatDetails(outcome.input);
  const title = clip(intent ?? `${appName}: ${words}`, 120);
  const base = {
    integration: outcome.app,
    tool: outcome.tool,
    title,
    details,
    args: outcome.input,
    resume: { executionId: outcome.requestId, source: "executor" as const },
  };
  const has = (re: RegExp) => re.test(` ${words} `);
  const body = firstString(outcome.input, ["body", "text", "message", "content", "html"]);
  if (has(/ (send|reply|forward|post|publish) /) && body) {
    const to = firstString(outcome.input, ["to", "recipient", "recipients", "channel", "email"]);
    const subject = firstString(outcome.input, ["subject", "title"]);
    return {
      ...base,
      presentation: {
        kind: "draft",
        props: {
          kind: /mail/i.test(outcome.app) ? "Email" : "Message",
          ...(to ? { to: clip(to, 200) } : {}),
          ...(subject ? { subject: clip(subject, 200) } : {}),
          body: body.slice(0, 20_000),
          primary: { label: clip(`Send from ${appName}`, 40) },
        },
      },
    };
  }
  const booking = has(/ (book|booking|reserve|reservation|hold) /);
  if (booking || has(/ (purchase|buy|checkout|pay|payment) /)) {
    return {
      ...base,
      presentation: {
        kind: "action",
        props: {
          kind: booking ? "Book" : "Buy",
          title,
          body: clip(intent ?? `${appName} · ${words}`, 200),
          ...(details.length ? { details: details.slice(0, 8) } : {}),
          confirm: booking ? "Book" : "Buy",
          change: "Change",
        },
      },
      offer: { description: clip(`Always allow ${outcome.tool} in ${appName}`, 120) },
    };
  }
  return {
    ...base,
    reason: clip(`${appName} asks for an OK before this one.`, 200),
    offer: { description: clip(`Always allow ${outcome.tool} in ${appName}`, 120) },
  };
}

export function titleCase(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "refunds.create" → "refunds create", "sendEmail" → "send email". */
function toolWords(tool: string): string {
  return tool
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._\-/]+/g, " ")
    .toLowerCase()
    .trim();
}

function flatDetails(input: Record<string, unknown>): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const visit = (value: unknown, label: string, depth: number) => {
    if (rows.length >= 10) return;
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      if (depth >= 2) return;
      for (const [key, inner] of Object.entries(value as Record<string, unknown>))
        visit(inner, label ? `${label} ${key}` : key, depth + 1);
      return;
    }
    rows.push({ label: clip(titleCase(toolWords(label || "value")), 40), value: clip(String(value), 160) });
  };
  visit(input, "", 0);
  return rows;
}

function firstString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.every((v) => typeof v === "string") && value.length)
      return value.join(", ");
  }
  return undefined;
}

function toolName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

function firstLine(value: string): string {
  return clip(value.split(/\n/)[0] ?? value, 300);
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Poke's "Connected apps" prompt section: one line per app, its accounts, then MCP servers. */
export function integrationsSummary(
  integrations: readonly Integration[],
  servers: readonly McpServerConfig[],
): string | undefined {
  const lines = integrations
    .filter((i) => i.accounts.some((a) => a.status === "connected"))
    .map((i) => {
      const accounts = i.accounts.filter((a) => a.status === "connected");
      const names = accounts.map((a) =>
        a.id === i.defaultAccountId && accounts.length > 1 ? `${a.label} (default)` : a.label,
      );
      return `- ${i.name}${names.some((n) => n !== i.name) ? `: ${names.join(", ")}` : ""}`;
    });
  for (const server of servers.filter((s) => s.enabled))
    lines.push(`- ${server.name} (MCP server${server.toolCount ? `, ${server.toolCount} tools` : ""})`);
  return lines.length ? lines.join("\n") : undefined;
}
