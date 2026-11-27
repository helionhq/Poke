import {
  type Clock,
  DomainError,
  EMBEDDING_DIMENSIONS,
  LLM_ROLES,
  type ModelAssignment,
  type ModelCatalog,
  type ModelInfo,
  PROVIDERS,
  type ProviderInfo,
  providerAllowsRole,
  type Repositories,
  ROLE_LABELS,
  type Role,
  ALL_ROLES,
  type SystemSecretKey,
  type SystemSecrets,
} from "@poke/domain";
import type { EventHub } from "./core/hub.js";

/** Where each `poke login <id>` credential lives in the vault's system namespace. */
export const LOGIN_SECRETS: Record<string, SystemSecretKey> = {
  anthropic: "anthropic.oauthToken",
  qwen: "qwen.apiKey",
  "qwen-cn": "qwenCn.apiKey",
  voyage: "voyage.apiKey",
};

export interface LoginInfo {
  id: string;
  name: string;
  providers: string[];
  loggedIn: boolean;
  /** When the credential stops working, where that is known (a claude setup-token lasts a year). */
  expiresAt?: number;
}

/** `claude setup-token` makes a token that lasts about a year (brief section 3). */
export const CLAUDE_TOKEN_LIFETIME_MS = 365 * 86_400_000;

/** Checks a credential against its service before it is saved. */
export type LoginValidator = (secret: string) => Promise<{ ok: true } | { ok: false; error: string }>;

export class LoginService {
  constructor(
    private readonly secrets: SystemSecrets,
    private readonly validators: Partial<Record<string, LoginValidator>> = {},
  ) {}

  list(): LoginInfo[] {
    const byLogin = new Map<string, LoginInfo>();
    for (const provider of PROVIDERS.filter((p) => p.enabled)) {
      const key = LOGIN_SECRETS[provider.loginId];
      if (!key) continue;
      const entry = byLogin.get(provider.loginId) ?? {
        id: provider.loginId,
        name: provider.name,
        providers: [],
        loggedIn: this.secrets.has(key),
      };
      const setAt = provider.loginId === "anthropic" ? this.secrets.updatedAt?.(key) : undefined;
      if (setAt !== undefined && entry.expiresAt === undefined)
        entry.expiresAt = setAt + CLAUDE_TOKEN_LIFETIME_MS;
      entry.providers.push(provider.id);
      byLogin.set(provider.loginId, entry);
    }
    return [...byLogin.values()];
  }

  async login(id: string, secret: string): Promise<void> {
    const key = LOGIN_SECRETS[id];
    if (!key)
      throw new DomainError(
        "invalid",
        `Unknown login ${id}. Choose one of: ${Object.keys(LOGIN_SECRETS).join(", ")}`,
      );
    const value = secret.trim();
    if (!value || /\s/.test(value)) throw new DomainError("invalid", "That doesn't look like a key or token");
    const validator = this.validators[id];
    if (validator) {
      const result = await validator(value);
      if (!result.ok) throw new DomainError("unauthorized", result.error);
    }
    this.secrets.set(key, value);
  }

  logout(id: string): boolean {
    const key = LOGIN_SECRETS[id];
    if (!key) throw new DomainError("invalid", `Unknown login ${id}`);
    const had = this.secrets.has(key);
    this.secrets.delete(key);
    return had;
  }

  /** The credential for a provider id (pi-ai provider, "anthropic", "voyage"). */
  secretFor(providerId: string): string | undefined {
    const provider = PROVIDERS.find((p) => p.id === providerId);
    const key = provider ? LOGIN_SECRETS[provider.loginId] : undefined;
    return key ? this.secrets.get(key) : undefined;
  }

  isLoggedIn(providerId: string): boolean {
    return this.secretFor(providerId) !== undefined;
  }
}

export interface SetModelInput {
  role: string;
  provider: string;
  model: string;
  reasoning?: string;
  voiceReasoning?: string;
}

/**
 * Role → provider/model/reasoning. Every role starts unset and nothing is picked automatically;
 * the Claude subscription is refused for any role but Poke and Side chat.
 */
export class ModelService {
  constructor(
    private readonly repos: Pick<Repositories, "models">,
    private readonly hub: EventHub,
    private readonly catalogs: Partial<Record<string, ModelCatalog>>,
    private readonly clock: Clock,
    /** When given, a provider must be logged in before a role can use it. */
    private readonly loggedIn?: (providerId: string) => boolean,
  ) {}

  assignments(): ModelAssignment[] {
    return this.repos.models.all();
  }

  get(role: Role): ModelAssignment | undefined {
    return this.repos.models.get(role);
  }

  providersFor(role: Role): ProviderInfo[] {
    return PROVIDERS.filter((provider) => providerAllowsRole(provider, role));
  }

  async models(provider: string): Promise<ModelInfo[]> {
    return (await this.catalogs[provider]?.list(provider)) ?? [];
  }

  async info(role: Role): Promise<ModelInfo | undefined> {
    const assignment = this.get(role);
    if (!assignment) return undefined;
    return this.catalogs[assignment.provider]?.get(assignment.provider, assignment.model);
  }

  async set(input: SetModelInput): Promise<ModelAssignment> {
    const role = parseRole(input.role);
    const provider = PROVIDERS.find((p) => p.id === input.provider);
    if (!provider) throw new DomainError("invalid", `Unknown provider ${input.provider}`);
    if (!providerAllowsRole(provider, role)) {
      throw new DomainError(
        "forbidden",
        provider.kind === "claude-agent-sdk"
          ? "The Claude subscription is only for the Poke and Side chat roles"
          : `${provider.name} can't serve the ${ROLE_LABELS[role]} role`,
      );
    }
    if (this.loggedIn && !this.loggedIn(provider.id)) {
      throw new DomainError(
        "unauthorized",
        `Log in to ${provider.name} first: poke login ${provider.loginId}`,
      );
    }
    const info = await this.catalogs[provider.id]?.get(provider.id, input.model);
    if (!info) {
      const known = (await this.models(provider.id)).map((m) => m.id);
      throw new DomainError(
        "invalid",
        `${provider.name} has no model ${input.model}${known.length ? `. Try: ${known.join(", ")}` : ""}`,
      );
    }
    for (const [field, level] of [
      ["reasoning", input.reasoning],
      ["voiceReasoning", input.voiceReasoning],
    ] as const) {
      if (level !== undefined && !info.reasoningLevels.includes(level)) {
        throw new DomainError(
          "invalid",
          info.reasoningLevels.length
            ? `${info.name} supports ${field === "voiceReasoning" ? "voice " : ""}reasoning ${info.reasoningLevels.join(", ")}`
            : `${info.name} has no reasoning levels`,
        );
      }
    }
    if (input.voiceReasoning !== undefined && role !== "poke") {
      throw new DomainError("invalid", "Voice reasoning applies to the Poke role only");
    }
    const assignment: ModelAssignment = {
      role,
      provider: provider.id,
      model: info.id,
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.voiceReasoning !== undefined ? { voiceReasoning: input.voiceReasoning } : {}),
      ...(role === "memory.embeddings" ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
      updatedAt: this.clock.now(),
    };
    this.hub.publish(() => {
      this.repos.models.set(assignment);
      return [{ type: "models.updated", roles: [role] }];
    });
    return assignment;
  }

  unset(role: string): void {
    const parsed = parseRole(role);
    this.hub.publish(() => {
      this.repos.models.unset(parsed);
      return [{ type: "models.updated", roles: [parsed] }];
    });
  }
}

export function parseRole(role: string): Role {
  if ((ALL_ROLES as readonly string[]).includes(role)) return role as Role;
  throw new DomainError("invalid", `Unknown role ${role}. Roles: ${ALL_ROLES.join(", ")}`);
}

export const isLlmRole = (role: Role): boolean => (LLM_ROLES as readonly string[]).includes(role);
