import { query as sdkQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "@poke/agent-core";
import {
  ANTHROPIC_ALLOWED_ROLES,
  type ConversationRuntime,
  type ConversationSession,
  DomainError,
  type Logger,
  type RuntimeCapabilities,
  type SessionProfile,
  type SessionSpec,
} from "@poke/domain";
import { CLAUDE_PROVIDER, type SdkModel } from "./catalog.js";
import { claudeEnv } from "./env.js";
import { ClaudeSession, type QueryFn } from "./session.js";

export interface ClaudeRuntimeOptions {
  /** CLAUDE_CODE_OAUTH_TOKEN, read from Poke's secret store when a session opens. */
  token(): string | undefined;
  /** Poke's own CLAUDE_CONFIG_DIR (sessions, credentials cache), under Poke's data directory. */
  configDir: string;
  log: Logger;
  /** Injected in tests; defaults to the Agent SDK's query(). */
  query?: QueryFn;
  /** Path to a Claude Code executable, when not using the SDK's bundled one. */
  executable?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * The Claude subscription, through the Agent SDK. It serves exactly two roles, Poke and side
 * chats; executors, memory and the model gateway never reach it (enforced here and in the model
 * registry).
 */
export class ClaudeConversationRuntime implements ConversationRuntime {
  readonly kind = "claude-agent-sdk" as const;

  constructor(private readonly options: ClaudeRuntimeOptions) {}

  capabilities(profile: SessionProfile): RuntimeCapabilities {
    return {
      steering: true,
      idleCompaction: profile === "poke" ? "command" : "none",
      toolSearch: true,
      codemode: false,
    };
  }

  async openSession(spec: SessionSpec): Promise<ConversationSession> {
    if (spec.model.provider !== CLAUDE_PROVIDER) {
      throw new DomainError("invalid", `The Claude runtime can't run ${spec.model.provider} models`);
    }
    const role = spec.profile === "poke" ? "poke" : "sidechat";
    if (!ANTHROPIC_ALLOWED_ROLES.includes(role) || !ANTHROPIC_ALLOWED_ROLES.includes(spec.model.role)) {
      throw new DomainError("forbidden", "The Claude subscription is only for Poke and side chats");
    }
    const token = this.options.token();
    if (!token) throw new DomainError("unauthorized", "Claude isn't signed in. Run `poke login anthropic`.");
    return new ClaudeSession(spec, {
      query: this.options.query ?? (sdkQuery as unknown as QueryFn),
      token,
      configDir: this.options.configDir,
      log: this.options.log,
      ...(this.options.executable ? { executable: this.options.executable } : {}),
      ...(this.options.baseEnv ? { baseEnv: this.options.baseEnv } : {}),
    });
  }
}

/**
 * The models the subscription offers, from the Agent SDK's supportedModels(). Starts Claude
 * Code without sending a prompt, so it spends nothing.
 */
export async function sdkModels(options: {
  token: string;
  configDir: string;
  cwd: string;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<SdkModel[]> {
  const input = new AsyncQueue<SDKUserMessage>();
  const query = sdkQuery({
    prompt: input,
    options: {
      settingSources: [],
      tools: [],
      persistSession: false,
      cwd: options.cwd,
      env: claudeEnv({
        token: options.token,
        configDir: options.configDir,
        ...(options.baseEnv ? { base: options.baseEnv } : {}),
      }),
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return (await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Claude Code didn't list its models in time")),
          options.timeoutMs ?? 30_000,
        );
      }),
    ])) as SdkModel[];
  } finally {
    if (timer) clearTimeout(timer);
    input.close();
    query.close();
  }
}
