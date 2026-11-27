import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  defineSignal,
  defineTool,
  type Extension,
  Harness,
  hook,
  LiveDoc,
  MemoryStorage,
  type Registry,
  type Storage,
  ToolTask,
  type ToolExecutionResult,
  type ToolRegistration,
  wrapTool,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { obj, str } from "@earendil-works/pi-schema";
import type {
  AgentRef,
  Logger,
  ToolInterceptor,
  ToolInvoker,
  ToolOutputItem,
  ToolResultData,
  ToolSpec,
} from "@poke/domain";

/** A parked tool call waits on this signal, keyed by the need id. */
export const NeedSignal = defineSignal({ name: "poke.need", version: 1, schema: obj({ json: str() }) });

export const COMPACTION_DEFAULTS = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 32_768,
} as const;

/**
 * Compaction for one conversation: Pi's own compaction, capped at Poke's budget. On a model whose
 * window is bigger than the budget, raise reserveTokens so the threshold lands at the budget.
 */
export function compactionFor(
  model: { provider: string; id: string; contextWindow: number },
  budget: number,
) {
  const overrides: Record<string, { reserveTokens: number }> = {};
  if (model.contextWindow > budget) {
    overrides[`${model.provider}/${model.id}`] = {
      reserveTokens: model.contextWindow - budget + COMPACTION_DEFAULTS.reserveTokens,
    };
  }
  return { ...COMPACTION_DEFAULTS, modelOverrides: overrides };
}

export interface Binding {
  agent: AgentRef;
  invoker: ToolInvoker;
  interceptor: ToolInterceptor;
}

export type HostToolEvent =
  | { type: "tool.started"; callId: string; name: string; args: unknown; nested: boolean }
  | { type: "tool.completed"; callId: string; name: string; isError: boolean; excerpt?: string };

export interface PiHostOptions {
  /** durable.sqlite, or omit for in-memory storage (side chats, tests). */
  path?: string;
  models: MutableModels;
  workspace: string;
  log: Logger;
  /** Shared across hosts so side chats reuse the same tool definitions. */
  registry?: Registry;
  now?: () => number;
}

const NOT_BOUND: ToolExecutionResult = {
  output: [{ type: "text", text: "This tool isn't available in this conversation right now." }],
  isError: true,
};

/**
 * One Pi Durable Harness and the extensions Poke installs on it. Tools are bound per conversation:
 * the registry is process-wide, so a tool call finds its agent, invoker and interceptor through
 * the conversation id it runs in.
 */
export class PiHost {
  readonly harness: Harness;
  readonly registry: Registry;
  readonly models: MutableModels;
  readonly workspace: string;
  readonly log: Logger;
  readonly #bindings = new Map<number, Binding>();
  readonly #toolListeners = new Map<number, Set<(event: HostToolEvent) => void>>();
  readonly #profiles = new Map<string, { extension: Extension; signature: string }>();
  readonly #releases = new Map<number, () => void>();
  readonly #started = new Map<number, Set<string>>();

  static async open(options: PiHostOptions): Promise<PiHost> {
    const registry = options.registry ?? createRegistry();
    installBase(registry);
    const storage: Storage = options.path ? await openNodeSqliteStorage(options.path) : new MemoryStorage();
    const harness = await Harness.open(
      storage,
      {
        models: () => options.models,
        registry,
        identity: { attribution: null },
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.workspace }),
        settings: {
          compaction: COMPACTION_DEFAULTS,
          retry: { maxRetries: 3 },
          afterFailedRun: "continue",
        },
        ...(options.now ? { now: options.now } : {}),
        onReport: (report) =>
          options.log.warn({ kind: report.kind, error: String(report.error ?? "") }, "pi-durable report"),
      },
      BACKGROUND_CONTEXT,
    );
    const host = new PiHost(harness, registry, options);
    activeHosts.add(host);
    return host;
  }

  private constructor(harness: Harness, registry: Registry, options: PiHostOptions) {
    this.harness = harness;
    this.registry = registry;
    this.models = options.models;
    this.workspace = options.workspace;
    this.log = options.log;
  }

  bind(conversationId: number, binding: Binding): void {
    this.#bindings.set(conversationId, binding);
  }

  unbind(conversationId: number): void {
    this.#bindings.delete(conversationId);
    this.#toolListeners.delete(conversationId);
    this.#started.delete(conversationId);
  }

  binding(conversationId: number): Binding | undefined {
    return this.#bindings.get(conversationId);
  }

  onTool(conversationId: number, listener: (event: HostToolEvent) => void): () => void {
    let set = this.#toolListeners.get(conversationId);
    if (!set) this.#toolListeners.set(conversationId, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * The extension that carries one profile's ToolSpecs ("executor", "poke", "sidechat").
   * Reinstalled in place when the specs change (a new milestone's tools, an MCP server added).
   */
  profileExtension(profile: string, specs: ToolSpec[]): Extension {
    const signature = JSON.stringify(
      specs.map((s) => [s.name, s.description, s.inputSchema, s.loading, s.callers]),
    );
    const existing = this.#profiles.get(profile);
    if (existing && existing.signature === signature) return existing.extension;
    const extension = defineExtension({
      name: `poke.tools.${profile}`,
      tools: specs.map((spec) => this.#piTool(spec)),
    });
    this.registry.install(extension);
    this.#profiles.set(profile, { extension, signature });
    return extension;
  }

  /** Extensions selected for an agent: coding tools and codemode for working agents, tools only for Poke. */
  extensionsFor(kind: "executor" | "poke" | "sidechat", specs: ToolSpec[]): Extension[] {
    const tools = this.profileExtension(kind, specs);
    const base = baseExtensions.get(this.registry)!;
    if (kind === "poke") return [tools, base.observe];
    return [base.coding, base.codemode, base.toolSearch, tools, base.observe];
  }

  async conversation(id: number | string): Promise<Conversation | undefined> {
    return this.harness.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT);
  }

  /** Find the parked tool call waiting on a need and deliver its resolution. */
  async signalNeed(conversationId: number, needId: string, value: unknown) {
    const live = await this.harness.snapshot(LiveDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
    const candidates = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].filter(
      (slot) => slot.status === "sleeping" && slot.taskId !== undefined,
    );
    for (const slot of candidates) {
      const task = await this.harness.getTask(slot.taskId!, BACKGROUND_CONTEXT);
      const state = task?.state as { status?: string; signals?: readonly string[] } | undefined;
      if (state?.status === "sleeping" && JSON.stringify(state.signals ?? []).includes(needId)) {
        return this.harness.signal(
          slot.taskId!,
          NeedSignal,
          needId,
          { json: JSON.stringify(value ?? null) },
          BACKGROUND_CONTEXT,
        );
      }
    }
    return "not_found" as const;
  }

  async close(): Promise<void> {
    activeHosts.delete(this);
    await this.harness.close(BACKGROUND_CONTEXT);
  }

  // ── internals used by the shared extensions ─────────────────────────────────────────────────

  /** @internal */
  emitTool(conversationId: number, event: HostToolEvent): void {
    if (event.type === "tool.started") {
      let started = this.#started.get(conversationId);
      if (!started) this.#started.set(conversationId, (started = new Set()));
      // beforeTool runs again after a parked call wakes; report a call once.
      if (started.has(event.callId)) return;
      started.add(event.callId);
    }
    for (const listener of this.#toolListeners.get(conversationId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn({ error: String(error) }, "tool listener failed");
      }
    }
  }

  /** @internal */
  setRelease(taskId: number, release: () => void): void {
    this.#releases.get(taskId)?.();
    this.#releases.set(taskId, release);
  }

  /** @internal */
  release(taskId: number): void {
    this.#releases.get(taskId)?.();
    this.#releases.delete(taskId);
  }

  #piTool(spec: ToolSpec): ToolRegistration {
    return defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
      replay: spec.replay,
      callers: spec.callers,
      ...(spec.loading === "deferred" ? { deferred: true as const } : {}),
      execute: async (args, api, context) => {
        const binding = this.#bindings.get(Number(api.conversationId));
        if (!binding) return NOT_BOUND;
        let resume: { needId: string; value: unknown } | undefined;
        const parked = api.checkpoint as { needId?: string } | undefined;
        if (parked?.needId) {
          const state = await api.readSignal(NeedSignal, parked.needId, context);
          if (state?.kind === "value")
            resume = { needId: parked.needId, value: JSON.parse(state.value.json) };
          else if (state?.kind === "expired") resume = { needId: parked.needId, value: { expired: true } };
        }
        const controller = new AbortController();
        const signal = context.abortSignal;
        if (signal) {
          if (signal.aborted) controller.abort();
          else signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        let result: ToolResultData;
        try {
          result = await binding.invoker.invoke(spec.name, args, {
            agent: binding.agent,
            callId: api.callId,
            signal: controller.signal,
            ...(resume ? { resume } : {}),
            output: (text) => api.output(binding.interceptor.redact(text)),
          });
        } catch (error) {
          return {
            output: [{ type: "text", text: binding.interceptor.redact(errorText(error)) }],
            isError: true,
          };
        }
        if (result.park) {
          return {
            kind: "sleep",
            signals: [NeedSignal.key(result.park.needId)],
            ...(result.park.until !== undefined ? { until: result.park.until } : {}),
            checkpoint: { needId: result.park.needId },
          };
        }
        return toPiResult(result);
      },
    });
  }
}

/** Hosts alive in this process, for the shared extensions to find their own. */
/** Coding tools whose arguments get vault placeholders filled in before they run. */
const FILLED_TOOLS = new Set(["write", "edit"]);

const activeHosts = new Set<PiHost>();
function hostOf(conversationId: number): PiHost | undefined {
  for (const host of activeHosts) if (host.binding(conversationId)) return host;
  return undefined;
}

interface BaseExtensions {
  coding: Extension;
  codemode: Extension;
  toolSearch: Extension;
  observe: Extension;
}
const baseExtensions = new WeakMap<Registry, BaseExtensions>();

function installBase(registry: Registry): void {
  if (baseExtensions.has(registry)) return;
  const wrap = <T extends ToolRegistration>(tool: T) =>
    wrapTool(tool, (base) => ({
      ...base,
      execute: async (args, api, context) => {
        const conversationId = Number(api.conversationId);
        const host = hostOf(conversationId);
        const binding = host?.binding(conversationId);
        if (!host || !binding) return NOT_BOUND;
        // write and edit get vault placeholders filled in here; bash does it in its own prepare
        // hook (as environment variables). The transcript keeps the placeholders.
        let release: (() => void) | undefined;
        try {
          let input = args;
          if (FILLED_TOOLS.has(base.name)) {
            const prepared = await binding.interceptor.prepare(base.name, args, binding.agent);
            input = prepared.args as typeof args;
            release = prepared.release;
          }
          const result = await base.execute(input, api, context);
          if ("kind" in result) return result;
          return redactResult(result, (text) => binding.interceptor.redact(text));
        } catch (error) {
          return {
            output: [{ type: "text", text: binding.interceptor.redact(errorText(error)) }],
            isError: true,
          };
        } finally {
          release?.();
          host.release(Number(api.taskId));
        }
      },
    }));
  const bash = createBashTool({
    // Vault placeholders become per-call environment variables here (milestone 5); the
    // arguments the transcript stores keep the placeholders.
    prepare: async (execution, api) => {
      const conversationId = Number(api.conversationId);
      const host = hostOf(conversationId);
      const binding = host?.binding(conversationId);
      if (!host || !binding) return;
      const prepared = await binding.interceptor.prepare(
        "bash",
        { command: execution.command },
        binding.agent,
      );
      const command = (prepared.args as { command?: unknown }).command;
      if (typeof command === "string") execution.command = command;
      Object.assign(execution.env, prepared.env ?? {});
      host.setRelease(Number(api.taskId), prepared.release);
    },
  });
  const coding = [createReadTool(), createWriteTool(), createEditTool(), bash];
  const codingExtension = defineExtension({
    name: "poke.coding",
    tools: coding,
    wraps: coding.map((tool) => wrap(tool)),
  });
  const codemode = createCodemodeExtension({
    sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
  });
  const toolSearch = createToolSearchExtension();
  const observe = defineExtension({
    name: "poke.observe",
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api) => {
          const conversationId = Number(api.conversationId);
          hostOf(conversationId)?.emitTool(conversationId, {
            type: "tool.started",
            callId: call.id,
            name: call.name,
            args: call.arguments,
            nested: call.parent !== undefined,
          });
          return undefined;
        },
        afterTool: (call, result, api) => {
          const conversationId = Number(api.conversationId);
          const excerpt = excerptOf(result.output);
          hostOf(conversationId)?.emitTool(conversationId, {
            type: "tool.completed",
            callId: call.id,
            name: call.name,
            isError: result.isError === true,
            ...(excerpt ? { excerpt } : {}),
          });
          return undefined;
        },
      }),
    ],
  });
  for (const extension of [codingExtension, codemode, toolSearch, observe])
    registry.install(extension as Extension);
  baseExtensions.set(registry, {
    coding: codingExtension as Extension,
    codemode: codemode as Extension,
    toolSearch: toolSearch as Extension,
    observe,
  });
}

function toPiResult(result: ToolResultData): ToolExecutionResult {
  return {
    output: result.output.map((item) =>
      item.type === "text"
        ? { type: "text" as const, text: item.text }
        : { type: "image" as const, data: item.data, mimeType: item.mimeType },
    ),
    ...(result.isError ? { isError: true } : {}),
    ...(result.details ? { details: result.details as never } : {}),
  };
}

function redactResult(result: ToolExecutionResult, redact: (text: string) => string): ToolExecutionResult {
  const output = result.output?.map((item) =>
    item.type === "text" ? { ...item, text: redact(item.text) } : item,
  );
  let structuredOutput = result.structuredOutput;
  if (structuredOutput !== undefined)
    structuredOutput = JSON.parse(redact(JSON.stringify(structuredOutput))) as never;
  return {
    ...result,
    ...(output ? { output } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
  };
}

function excerptOf(output: ToolExecutionResult["output"]): string | undefined {
  const text = output
    ?.filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textOf(items: readonly ToolOutputItem[]): string {
  return items.map((i) => (i.type === "text" ? i.text : "")).join("");
}

export function withSignal(context: Context = BACKGROUND_CONTEXT): Context {
  return context;
}
