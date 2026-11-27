import { ToolInputError } from "@poke/agent-core";
import type {
  AgentRef,
  Logger,
  ToolCallContext,
  ToolInterceptor,
  ToolInvoker,
  ToolObservation,
  ToolResultData,
  ToolSpec,
} from "@poke/domain";
import { DomainError } from "@poke/domain";
import type { SecretRedactor } from "./redactor.js";
import type { SecretResolver } from "./secrets.js";

export type ToolProfile = "poke" | "executor" | "sidechat";

export interface RegisterOptions {
  /**
   * Fill in vault placeholders before the tool runs. Only for tools that act outside Poke
   * (Executor calls, the browser, HTTP): a tool that passes text on to a model, such as
   * send_to_agent, must keep the placeholders.
   */
  resolveSecrets?: boolean;
  /** Recorded as "Used by" on the vault entries the tool used. */
  usedBy?: string;
}

export interface ToolHandler<A = unknown> {
  spec: ToolSpec;
  parse(args: unknown): A;
  run(args: A, ctx: ToolCallContext): Promise<ToolResultData> | ToolResultData;
}

/** A tool definition from agent-core plus the function that does the work. */
export function handler<A>(
  definition: { spec: ToolSpec; parse(args: unknown): A },
  run: (args: A, ctx: ToolCallContext) => Promise<ToolResultData> | ToolResultData,
): ToolHandler<A> {
  return { spec: definition.spec, parse: (args) => definition.parse(args), run };
}

export const text = (value: string, isError = false): ToolResultData => ({
  output: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

export const json = (value: unknown): ToolResultData => text(JSON.stringify(value, null, 2));

/**
 * Every tool call from every agent goes through here: argument validation, vault placeholders
 * (milestone 5), redaction of anything secret in the result, and the log. Runtimes only see
 * ToolSpecs and an invoker.
 */
export class ToolGateway {
  readonly #handlers = new Map<string, ToolHandler>();
  readonly #profiles = new Map<ToolProfile, Set<string>>();
  readonly #options = new Map<string, RegisterOptions>();
  readonly interceptor: ToolInterceptor;

  constructor(
    private readonly redactor: SecretRedactor,
    private readonly log: Logger,
    private readonly resolver?: SecretResolver,
  ) {
    this.interceptor = {
      // The runtimes' own tools (bash, write, edit): placeholders are filled in at execution.
      prepare: async (name, args, agent) =>
        this.resolver ? this.resolver.prepare(name, args, agent, name) : { args, release: () => {} },
      redact: (value) => this.redactor.redact(value),
      observe: (event) => this.#observe(event),
    };
  }

  register(
    tool: ToolHandler<never> | ToolHandler<unknown>,
    profiles: ToolProfile[],
    options: RegisterOptions = {},
  ): void {
    const entry = tool as ToolHandler;
    this.#handlers.set(entry.spec.name, entry);
    this.#options.set(entry.spec.name, options);
    for (const profile of profiles) {
      let set = this.#profiles.get(profile);
      if (!set) this.#profiles.set(profile, (set = new Set()));
      set.add(entry.spec.name);
    }
  }

  /** Remove a tool (an MCP server was removed or restarted). Agents started later won't see it. */
  unregister(name: string): void {
    this.#handlers.delete(name);
    this.#options.delete(name);
    for (const set of this.#profiles.values()) set.delete(name);
  }

  has(name: string): boolean {
    return this.#handlers.has(name);
  }

  specs(profile: ToolProfile): ToolSpec[] {
    return [...(this.#profiles.get(profile) ?? [])].map((name) => this.#handlers.get(name)!.spec);
  }

  invoker(profile: ToolProfile): ToolInvoker {
    return { invoke: (name, args, ctx) => this.invoke(profile, name, args, ctx) };
  }

  async invoke(
    profile: ToolProfile,
    name: string,
    args: unknown,
    ctx: ToolCallContext,
  ): Promise<ToolResultData> {
    const tool = this.#handlers.get(name);
    if (!tool || !this.#profiles.get(profile)?.has(name))
      return text(`There's no tool called ${name} here.`, true);
    const started = Date.now();
    const options = this.#options.get(name) ?? {};
    let release = () => {};
    try {
      let parsed = tool.parse(args);
      // A resumed call only settles what was paused (by its id): its placeholders were filled in
      // the first time, and a one-time code may be gone by now.
      if (options.resolveSecrets && this.resolver && !ctx.resume) {
        const prepared = this.resolver.prepare(name, parsed, ctx.agent, options.usedBy);
        parsed = prepared.args;
        release = prepared.release;
      }
      const result = await tool.run(parsed, ctx);
      // Parked (waiting for an OK): the call hasn't happened yet, so nothing is used up.
      if (result.park) release = () => {};
      this.log.debug(
        { tool: name, agent: describe(ctx.agent), ms: Date.now() - started, isError: result.isError },
        "tool call",
      );
      return this.#redactResult(result);
    } catch (error) {
      const message =
        error instanceof ToolInputError || error instanceof DomainError
          ? error.message
          : `${name} failed: ${errorMessage(error)}`;
      if (!(error instanceof ToolInputError || error instanceof DomainError)) {
        this.log.warn(
          { tool: name, agent: describe(ctx.agent), error: this.redactor.redact(errorMessage(error)) },
          "tool failed",
        );
      }
      return text(this.redactor.redact(message), true);
    } finally {
      release();
    }
  }

  #redactResult(result: ToolResultData): ToolResultData {
    return {
      ...result,
      output: result.output.map((item) =>
        item.type === "text" ? { ...item, text: this.redactor.redact(item.text) } : item,
      ),
      ...(result.details ? { details: this.redactor.redactValue(result.details) } : {}),
      ...(result.structured !== undefined
        ? { structured: this.redactor.redactValue(result.structured) }
        : {}),
    };
  }

  #observe(event: ToolObservation): void {
    this.log.debug({ ...event, args: undefined, agent: describe(event.agent) }, `tool ${event.type}`);
  }
}

function describe(agent: AgentRef): string {
  return agent.kind === "executor"
    ? `executor:${agent.taskId}`
    : agent.kind === "sidechat"
      ? `sidechat:${agent.sideChatId}`
      : "poke";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
