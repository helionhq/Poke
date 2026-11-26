import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PersonaSlots } from "@poke/agent-core";
import {
  AgentsService,
  ApprovalService,
  BlockService,
  IntegrationService,
  integrationsSummary,
  InteractionOrchestrator,
  LoginService,
  type LoginValidator,
  ModelService,
  type LiveSecret,
  SecretRedactor,
  SecretResolver,
  SideChatService,
  ToolGateway,
} from "@poke/application";
import { browseServer, parseBrowseStatus } from "@poke/browse";
import {
  type ConversationRuntime,
  type ExecutorPort,
  type McpConnector,
  type McpServerConfig,
  type ModelCatalog,
  type ProviderKind,
  type SearchPort,
} from "@poke/domain";
import { ExecutorClient } from "@poke/integrations-executor";
import { SdkMcpConnector } from "@poke/mcp-bridge";
import { KeenableSearch } from "@poke/search-keenable";
import {
  CLAUDE_PROVIDER,
  ClaudeConversationRuntime,
  ClaudeModelCatalog,
  type QueryFn,
  sdkModels,
  validateClaudeToken,
} from "@poke/runtime-claude-agent-sdk";
import {
  createPiModels,
  PI_PROVIDER_IDS,
  PiConversationRuntime,
  PiExecutorRuntime,
  PiHost,
  PiModelCatalog,
  validateQwenKey,
} from "@poke/runtime-pi-durable";
import { openVault, type SodiumVault } from "@poke/vault-sodium";
import { ensureMasterKey, loadMasterKey } from "./infra/master-key.js";
import type { Kernel } from "./kernel.js";
import type { StatusContributor } from "./status.js";

/** The vault, logins and the model registry: what `poke login` and `poke model` need. */
export interface ModelStack {
  vault: SodiumVault;
  logins: LoginService;
  models: ModelService;
  piModels: ReturnType<typeof createPiModels>;
  /** Every live secret value, for redaction. Refreshed whenever the vault changes. */
  secrets(): LiveSecret[];
  claudeConfigDir: string;
  close(): void;
}

export interface ModelStackOptions {
  /** Ask the Agent SDK which Claude models the subscription offers (spawns Claude Code once). */
  claudeLive?: boolean;
  /** Validate keys against their services before saving (default true). */
  validateLogins?: boolean;
  fetch?: typeof fetch;
}

export async function openModelStack(kernel: Kernel, options: ModelStackOptions = {}): Promise<ModelStack> {
  const { paths } = kernel;
  ensureMasterKey(paths.masterKey);
  let values: LiveSecret[] = [];
  const vault: SodiumVault = await openVault({
    path: paths.vaultDb,
    masterKey: loadMasterKey(paths.masterKey),
    clock: kernel.clock,
    onChange: () => refresh(),
  });
  // Every live secret value, decrypted once per vault change rather than on every redaction.
  // Entry secrets show up as [vault:<entry>], provider credentials as [vault:system].
  function refresh(): void {
    values = vault
      .liveSecrets()
      .filter((s) => s.value.length > 0)
      .map((s) => ({
        name: s.name.startsWith("system:") ? "system" : s.name.slice(0, s.name.lastIndexOf(".")),
        value: s.value,
      }));
  }
  refresh();

  const claudeConfigDir = join(paths.data, "claude");
  mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
  const logins = new LoginService(
    vault.system,
    options.validateLogins === false ? {} : loginValidators(() => piModels, options.fetch),
  );
  const piModels = createPiModels({ apiKey: (providerId) => logins.secretFor(providerId) });
  const piCatalog = new PiModelCatalog(piModels);
  const claudeCatalog = new ClaudeModelCatalog(
    options.claudeLive
      ? async () => {
          const token = logins.secretFor(CLAUDE_PROVIDER);
          if (!token) throw new Error("not logged in");
          return sdkModels({ token, configDir: claudeConfigDir, cwd: paths.workspace });
        }
      : undefined,
  );
  const catalogs: Record<string, ModelCatalog> = { [CLAUDE_PROVIDER]: claudeCatalog };
  for (const id of PI_PROVIDER_IDS) catalogs[id] = piCatalog;
  const models = new ModelService(kernel.db, kernel.hub, catalogs, kernel.clock, (id) =>
    logins.isLoggedIn(id),
  );
  return {
    vault,
    logins,
    models,
    piModels,
    secrets: () => values,
    claudeConfigDir,
    close: () => vault.close(),
  };
}

function loginValidators(
  piModels: () => ReturnType<typeof createPiModels>,
  fetchImpl?: typeof fetch,
): Record<string, LoginValidator> {
  return {
    anthropic: async (token) => validateClaudeToken(token),
    qwen: (key) => validateQwenKey(piModels(), "qwen-token-plan-individual", key, fetchImpl),
    "qwen-cn": (key) => validateQwenKey(piModels(), "qwen-token-plan-individual-cn", key, fetchImpl),
  };
}

/** Everything that thinks: runtimes, the tool gateway, executors, Poke itself, side chats. */
export interface AgentStack extends ModelStack {
  gateway: ToolGateway;
  host: PiHost;
  agents: AgentsService;
  blocks: BlockService;
  approvals: ApprovalService;
  integrations: IntegrationService;
  executor: ExecutorPort;
  poke: InteractionOrchestrator;
  sidechats: SideChatService;
  persona(): PersonaSlots;
  shutdown(): Promise<void>;
}

export interface AgentStackOptions extends ModelStackOptions {
  /** Tests inject a fake Agent SDK query(). */
  claudeQuery?: QueryFn;
  claudeExecutable?: string;
  /** Override runtimes (tests). */
  runtimes?: Partial<Record<ProviderKind, ConversationRuntime>>;
  /** Tests: fake integrations. */
  search?: SearchPort;
  mcpConnector?: McpConnector;
  executorTransport?: McpServerConfig["transport"];
  /** false: don't start browse (tests, or no browse installed). */
  browse?: false | McpServerConfig["transport"];
}

export async function openAgentStack(kernel: Kernel, options: AgentStackOptions = {}): Promise<AgentStack> {
  const stack = await openModelStack(kernel, { claudeLive: true, ...options });
  const { paths, settings, log } = kernel;
  const redactor = new SecretRedactor(stack.secrets);
  const resolver = new SecretResolver(stack.vault);
  const gateway = new ToolGateway(redactor, log, resolver);
  const mcp = options.mcpConnector ?? new SdkMcpConnector();
  const executor = new ExecutorClient({
    connector: mcp,
    token: () => stack.vault.system.get("executor.token"),
    org: () => settings.get("executor.org"),
    log,
    ...(options.executorTransport ? { transport: options.executorTransport } : {}),
  });
  const search =
    options.search ?? new KeenableSearch({ apiKey: () => stack.vault.system.get("keenable.key") });
  const persona = (): PersonaSlots => {
    const homeCity = settings.get("profile.homeCity");
    const integrations = integrationsSummary(
      kernel.db.integrations.list(),
      kernel.db.integrations.mcpServers(),
    );
    return {
      ...(integrations ? { integrations } : {}),
      userName: settings.userName(),
      timezone: settings.timezone(),
      ...(homeCity ? { homeCity } : {}),
      workspace: paths.workspace,
    };
  };
  const host = await PiHost.open({
    path: paths.durableDb,
    models: stack.piModels,
    workspace: paths.workspace,
    log,
    now: () => kernel.clock.now(),
  });
  const runtimes: Partial<Record<ProviderKind, ConversationRuntime>> = options.runtimes ?? {
    "pi-ai": new PiConversationRuntime(host),
    "claude-agent-sdk": new ClaudeConversationRuntime({
      token: () => stack.logins.secretFor(CLAUDE_PROVIDER),
      configDir: stack.claudeConfigDir,
      log,
      ...(options.claudeQuery ? { query: options.claudeQuery } : {}),
      ...(options.claudeExecutable ? { executable: options.claudeExecutable } : {}),
    }),
  };
  const agents = new AgentsService({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock: kernel.clock,
    log,
    runtime: new PiExecutorRuntime(host),
    models: stack.models,
    gateway,
    settings,
    persona,
    workspace: paths.workspace,
  });
  const approvals = new ApprovalService({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock: kernel.clock,
    log,
    agents,
    redact: (value) => redactor.redactValue(value),
  });
  const integrations = new IntegrationService({
    repos: kernel.db,
    clock: kernel.clock,
    timers: kernel.timers,
    log,
    gateway,
    approvals,
    executor,
    search,
    vault: stack.vault,
    mcp,
    resolver,
    ...(options.browse === false
      ? {}
      : { browse: { transport: options.browse ?? browseServer(), parseStatus: parseBrowseStatus } }),
  });
  const blocks = new BlockService({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock: kernel.clock,
    log,
    thread: kernel.thread,
    vault: stack.vault,
    agents,
    approvals,
    connections: integrations,
  });
  integrations.attachBlocks(blocks);
  const poke = new InteractionOrchestrator({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock: kernel.clock,
    timers: kernel.timers,
    log,
    thread: kernel.thread,
    attachments: kernel.attachments,
    settings,
    models: stack.models,
    runtimes,
    gateway,
    agents,
    blocks,
    presence: kernel.presence,
    persona,
    workspace: paths.workspace,
    skillsDir: paths.skills,
  });
  const sidechats = new SideChatService({
    repos: kernel.db,
    hub: kernel.hub,
    ids: kernel.ids,
    clock: kernel.clock,
    log,
    thread: kernel.thread,
    settings,
    models: stack.models,
    runtimes,
    gateway,
    persona,
    workspace: paths.workspace,
    skillsDir: paths.skills,
  });
  // One-time codes are wiped 10 minutes after they were saved, used or not.
  let sweeper: { cancel(): void } | undefined;
  const sweep = () => {
    try {
      const wiped = stack.vault.sweep(kernel.clock.now());
      if (wiped.length) log.info({ count: wiped.length }, "wiped expired one-time codes");
    } catch (error) {
      log.warn({ err: error }, "couldn't sweep the vault");
    }
    sweeper = kernel.timers.setTimeout(sweep, 60_000);
  };
  sweep();
  // Tools first, then executors pick up where they left off before the restart.
  blocks.start();
  approvals.start();
  // MCP servers and browse connect in the background; their tools reach agents started after.
  void integrations.connectAll().catch((error: unknown) => log.warn({ err: error }, "integrations"));
  poke.start();
  await agents.resume().catch((error: unknown) => log.error({ err: error }, "couldn't resume agents"));
  return {
    ...stack,
    gateway,
    host,
    agents,
    blocks,
    approvals,
    integrations,
    executor,
    poke,
    sidechats,
    persona,
    async shutdown() {
      sweeper?.cancel();
      await sidechats.closeAll();
      await poke.close();
      await integrations.close();
      await host.close();
      stack.close();
    },
  };
}

/** `poke status`: logins, and Poke's live context when the agents are running. */
export function stackStatus(stack: ModelStack | AgentStack): StatusContributor {
  return async (report) => {
    report.sections.logins = stack.logins.list().map((l) => ({ id: l.id, name: l.name, ok: l.loggedIn }));
    if ("poke" in stack) {
      const context = await stack.poke.context();
      report.context = {
        budget: context.budget,
        ...(context.tokens !== undefined ? { tokens: context.tokens } : {}),
        ...(context.lastCompaction
          ? {
              lastCompaction: {
                trigger: context.lastCompaction.trigger,
                at: context.lastCompaction.createdAt,
              },
            }
          : {}),
      };
    }
  };
}
