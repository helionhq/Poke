import type { ModelCatalog, ModelInfo } from "@poke/domain";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import {
  createModels,
  getSupportedThinkingLevels,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai/models";
import { qwenTokenPlanIndividualProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual";
import { qwenTokenPlanIndividualCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual-cn";

/** pi-ai provider ids Poke offers (verified against the installed pi-ai 1.6.1). */
export const PI_PROVIDER_IDS = ["qwen-token-plan-individual", "qwen-token-plan-individual-cn"] as const;

export interface PiModelsOptions {
  /** API key for a provider id, from Poke's secret store. Read on every request. */
  apiKey(providerId: string): string | undefined;
  /** Extra providers (tests use pi-ai's faux provider). */
  extraProviders?: Provider[];
}

/**
 * Keys come from the vault's system namespace through this read-only store; pi-ai never reads
 * environment variables or files on Poke's machine.
 */
class SecretStoreCredentials implements CredentialStore {
  constructor(private readonly apiKey: (providerId: string) => string | undefined) {}

  async read(providerId: string): Promise<Credential | undefined> {
    const key = this.apiKey(providerId);
    return key ? { type: "api_key", key } : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return PI_PROVIDER_IDS.filter((id) => this.apiKey(id)).map((providerId) => ({
      providerId,
      type: "api_key",
    }));
  }

  async modify(): Promise<Credential | undefined> {
    throw new Error("Credentials are managed with `poke login`");
  }

  async delete(): Promise<void> {
    throw new Error("Credentials are managed with `poke login`");
  }
}

export function createPiModels(options: PiModelsOptions): MutableModels {
  const models = createModels({
    credentials: new SecretStoreCredentials(options.apiKey),
    authContext: { env: async () => undefined, fileExists: async () => false },
    identity: { attribution: null },
  });
  models.setProvider(qwenTokenPlanIndividualProvider());
  models.setProvider(qwenTokenPlanIndividualCnProvider());
  for (const provider of options.extraProviders ?? []) models.setProvider(provider);
  return models;
}

export class PiModelCatalog implements ModelCatalog {
  constructor(private readonly models: MutableModels) {}

  async list(provider: string): Promise<ModelInfo[]> {
    return this.models.getModels(provider).map((m) => ({
      provider,
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxOutput: m.maxTokens,
      reasoningLevels: m.reasoning ? getSupportedThinkingLevels(m) : [],
      input: (m.input ?? ["text"]).filter((i): i is "text" | "image" => i === "text" || i === "image"),
    }));
  }

  async get(provider: string, model: string): Promise<ModelInfo | undefined> {
    return (await this.list(provider)).find((m) => m.id === model);
  }
}
