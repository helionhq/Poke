/** Model roles. Every role starts unset; nothing is ever picked automatically. */
export const LLM_ROLES = ["poke", "agents", "sidechat", "utility", "memory.chat"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];
export const ALL_ROLES = [...LLM_ROLES, "memory.embeddings"] as const;
export type Role = (typeof ALL_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  poke: "Poke",
  agents: "Agents",
  sidechat: "Side chat",
  utility: "Utility",
  "memory.chat": "Memory chat",
  "memory.embeddings": "Memory embeddings",
};

export type ProviderKind = "pi-ai" | "claude-agent-sdk" | "voyage";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  allowedRoles: Role[];
  /** The `poke login <id>` handle. */
  loginId: string;
}

/** v1 provider registry. Anthropic (subscription) is hard-limited to Poke and Side chat. */
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    name: "Claude (subscription)",
    kind: "claude-agent-sdk",
    enabled: true,
    allowedRoles: ["poke", "sidechat"],
    loginId: "anthropic",
  },
  {
    id: "qwen-token-plan-individual",
    name: "Qwen Token Plan",
    kind: "pi-ai",
    enabled: true,
    allowedRoles: ["poke", "agents", "sidechat", "utility", "memory.chat"],
    loginId: "qwen",
  },
  {
    id: "qwen-token-plan-individual-cn",
    name: "Qwen Token Plan CN",
    kind: "pi-ai",
    enabled: true,
    allowedRoles: ["poke", "agents", "sidechat", "utility", "memory.chat"],
    loginId: "qwen-cn",
  },
  {
    id: "voyage",
    name: "Voyage AI",
    kind: "voyage",
    enabled: true,
    allowedRoles: ["memory.embeddings"],
    loginId: "voyage",
  },
];

export const ANTHROPIC_ALLOWED_ROLES: readonly Role[] = ["poke", "sidechat"];

export function providerAllowsRole(provider: ProviderInfo, role: Role): boolean {
  if (provider.kind === "claude-agent-sdk" && !ANTHROPIC_ALLOWED_ROLES.includes(role)) return false;
  return provider.enabled && provider.allowedRoles.includes(role);
}

export interface ModelAssignment {
  role: Role;
  provider: string;
  model: string;
  /** Reasoning / effort level the model supports (pi thinkingLevel or Agent SDK effort). */
  reasoning?: string;
  /** Poke only: the reasoning level used for voice-call turns. */
  voiceReasoning?: string;
  /** Embeddings only: vector dimension baked into Honcho at first boot. */
  dimensions?: number;
  updatedAt: number;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxOutput?: number;
  reasoningLevels: string[];
  input: Array<"text" | "image">;
}

export function modelKey(ref: { provider: string; model: string }): string {
  return `${ref.provider}/${ref.model}`;
}

/** Honcho's vector column, fixed at first boot: changing it means re-creating memory. */
export const EMBEDDING_DIMENSIONS = 1024;
