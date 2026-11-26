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

export type ToolProfile = "poke" | "executor" | "sidechat";

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
  readonly interceptor: ToolInterceptor;

  constructor(
    private readonly redactor: SecretRedactor,
    private readonly log: Logger,
  ) {
    this.interceptor = {
      prepare: async (_name, args) => ({ args, release: () => {} }),
      redact: (value) => this.redactor.redact(value),
      observe: (event) => this.#observe(event),
    };
  }

  register(tool: ToolHandler<never> | ToolHandler<unknown>, profiles: ToolProfile[]): void {
    const entry = tool as ToolHandler;
    this.#handlers.set(entry.spec.name, entry);
    for (const profile of profiles) {
      let set = this.#profiles.get(profile);
      if (!set) this.#profiles.set(profile, (set = new Set()));
      set.add(entry.spec.name);
    }
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
    try {
      const parsed = tool.parse(args);
      const result = await tool.run(parsed, ctx);
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
