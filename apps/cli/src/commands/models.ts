import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_ROLES,
  type ModelAssignment,
  type ModelInfo,
  PROVIDERS,
  ROLE_LABELS,
  type Role,
} from "@poke/domain";
import { parseRole } from "@poke/application";
import { runClaudeSetupToken } from "@poke/server";
import type { Context } from "../admin.js";
import { registerSetupStep, skipOrRun } from "./setup.js";
import { cmd, dim, isInteractive, ok, p, pc, printJson, table, unwrap, warn } from "../ui.js";

// ── one API over the admin socket or the local stack ─────────────────────────────────────────

export interface LoginRow {
  id: string;
  name: string;
  providers: string[];
  loggedIn: boolean;
}

export interface RoleRow {
  role: Role;
  label: string;
  assignment?: ModelAssignment;
  providers: Array<{ id: string; name: string; loginId: string; loggedIn: boolean }>;
}

interface SetInput {
  provider: string;
  model: string;
  reasoning?: string;
  voiceReasoning?: string;
}

export interface ModelsApi {
  logins(): Promise<LoginRow[]>;
  login(id: string, secret: string): Promise<void>;
  logout(id: string): Promise<boolean>;
  roles(): Promise<RoleRow[]>;
  models(provider: string): Promise<ModelInfo[]>;
  set(role: Role, input: SetInput): Promise<ModelAssignment>;
  unset(role: Role): Promise<void>;
}

export async function modelsApi(ctx: Context): Promise<ModelsApi> {
  if (await ctx.online()) {
    const call = ctx.admin.call.bind(ctx.admin);
    return {
      logins: async () => (await call<{ logins: LoginRow[] }>("GET", "/admin/logins")).logins,
      login: async (id, secret) => void (await call("POST", `/admin/logins/${id}`, { secret }, 60_000)),
      logout: async (id) => (await call<{ removed: boolean }>("DELETE", `/admin/logins/${id}`)).removed,
      roles: async () => (await call<{ roles: RoleRow[] }>("GET", "/admin/models")).roles,
      models: async (provider) =>
        (await call<{ models: ModelInfo[] }>("GET", `/admin/models/providers/${provider}`, undefined, 60_000))
          .models,
      set: async (role, input) =>
        (await call<{ assignment: ModelAssignment }>("PUT", `/admin/models/${role}`, input, 60_000))
          .assignment,
      unset: async (role) => void (await call("DELETE", `/admin/models/${role}`)),
    };
  }
  const stack = await ctx.localModels();
  return {
    logins: async () => stack.logins.list(),
    login: (id, secret) => stack.logins.login(id, secret),
    logout: async (id) => stack.logins.logout(id),
    roles: async () =>
      ALL_ROLES.map((role) => {
        const assignment = stack.models.get(role);
        return {
          role,
          label: ROLE_LABELS[role],
          ...(assignment ? { assignment } : {}),
          providers: stack.models.providersFor(role).map((pr) => ({
            id: pr.id,
            name: pr.name,
            loginId: pr.loginId,
            loggedIn: stack.logins.isLoggedIn(pr.id),
          })),
        };
      }),
    models: (provider) => stack.models.models(provider),
    set: (role, input) => stack.models.set({ role, ...input }),
    unset: async (role) => stack.models.unset(role),
  };
}

const providerName = (id: string) => PROVIDERS.find((pr) => pr.id === id)?.name ?? id;

export function describeAssignment(a: ModelAssignment | undefined): string {
  if (!a) return pc.yellow("not set");
  const parts = [a.model, providerName(a.provider)];
  if (a.reasoning) parts.push(a.reasoning);
  if (a.voiceReasoning) parts.push(`voice ${a.voiceReasoning}`);
  return parts.join(" · ");
}

// ── poke login ───────────────────────────────────────────────────────────────────────────────

const LOGIN_HELP: Record<string, string> = {
  anthropic: "Claude subscription, for the Poke and Side chat roles only",
  qwen: "Qwen Token Plan Individual key (sk-sp-…)",
  "qwen-cn": "Qwen Token Plan Individual CN key (sk-sp-…)",
  voyage: "Voyage AI key, for memory embeddings",
};

export async function loginCommand(
  ctx: Context,
  id: string | undefined,
  opts: { logout?: boolean; stdin?: boolean; json?: boolean },
): Promise<void> {
  const api = await modelsApi(ctx);
  const logins = await api.logins();
  if (opts.json && !id) {
    printJson({ logins });
    return;
  }
  if (!id) {
    if (!isInteractive()) {
      console.log(
        table(
          logins.map((l) => [
            l.id,
            l.loggedIn ? ok("logged in") : dim("not set"),
            dim(LOGIN_HELP[l.id] ?? l.name),
          ]),
        ),
      );
      return;
    }
    id = unwrap(
      await p.select({
        message: opts.logout ? "Log out of which provider?" : "Log in to which provider?",
        options: logins.map((l) => ({
          value: l.id,
          label: `${l.name}  ${l.loggedIn ? pc.green("✓ logged in") : pc.dim("not set")}`,
          hint: LOGIN_HELP[l.id] ?? "",
        })),
      }),
    );
  }
  const login = logins.find((l) => l.id === id);
  if (!login) throw new Error(`Unknown provider ${id}. Choose one of: ${logins.map((l) => l.id).join(", ")}`);

  if (opts.logout) {
    const roles = (await api.roles()).filter(
      (r) => r.assignment && login.providers.includes(r.assignment.provider),
    );
    if (!(await api.logout(login.id))) {
      console.log(dim(`${login.name} wasn't logged in.`));
      return;
    }
    console.log(ok(`Logged out of ${login.name}.`));
    if (roles.length) {
      console.log(
        warn(
          `${roles.map((r) => r.label).join(", ")} ${roles.length === 1 ? "uses" : "use"} it and will stop working until you log in again or pick another model with ${cmd("poke model")}.`,
        ),
      );
    }
    return;
  }

  await loginFlow(ctx, api, login, Boolean(opts.stdin));
}

/** Ask for (or read) the credential, validate it on the server side, save it. */
export async function loginFlow(
  ctx: Context,
  api: ModelsApi,
  login: LoginRow,
  fromStdin = false,
): Promise<boolean> {
  let secret: string;
  if (fromStdin) {
    secret = await readStdin();
  } else {
    if (!isInteractive())
      throw new Error(
        `Run this in a terminal, or pipe the key in with ${cmd(`poke login ${login.id} --stdin`)}`,
      );
    if (login.id === "anthropic") {
      const how = unwrap(
        await p.select({
          message: "How do you want to log in to Claude?",
          options: [
            { value: "run", label: "Sign in now", hint: "runs `claude setup-token`; a browser opens" },
            {
              value: "paste",
              label: "Paste a token I already have",
              hint: "from `claude setup-token` on any machine",
            },
          ],
        }),
      );
      if (how === "run") {
        p.log.info(
          "Claude Code will open a sign-in page, then print a token that starts with sk-ant-oat. Copy it.",
        );
        const configDir = join(ctx.paths.data, "claude");
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        const code = await runClaudeSetupToken({ configDir });
        if (code !== 0) p.log.warn(`claude setup-token exited with code ${code}.`);
      }
    }
    secret = unwrap(
      await p.password({
        message: login.id === "anthropic" ? "Paste the token" : `Paste your ${login.name} key`,
        validate: (v) => (v?.trim() ? undefined : "Paste the value, or press Esc to cancel"),
      }),
    );
  }
  const spin = isInteractive() ? p.spinner() : undefined;
  spin?.start(`Checking with ${login.name}`);
  try {
    await api.login(login.id, secret);
  } catch (error) {
    spin?.error((error as Error).message);
    if (!spin) throw error;
    process.exitCode = 1;
    return false;
  }
  spin?.stop(ok(`Logged in to ${login.name}.`));
  if (!spin) console.log(ok(`Logged in to ${login.name}.`));
  return true;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

// ── poke model ───────────────────────────────────────────────────────────────────────────────

export async function modelCommand(
  ctx: Context,
  action: string | undefined,
  args: string[],
  opts: { reasoning?: string; voiceReasoning?: string; json?: boolean },
): Promise<void> {
  const api = await modelsApi(ctx);
  if (action === "set") {
    const [roleArg, spec] = args;
    if (!roleArg || !spec || !spec.includes("/")) {
      throw new Error(
        `Usage: ${cmd("poke model set <role> <provider>/<model> [--reasoning <level>] [--voice-reasoning <level>]")}`,
      );
    }
    const role = parseRole(roleArg);
    const slash = spec.indexOf("/");
    const assignment = await api.set(role, {
      provider: spec.slice(0, slash),
      model: spec.slice(slash + 1),
      ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      ...(opts.voiceReasoning ? { voiceReasoning: opts.voiceReasoning } : {}),
    });
    if (opts.json) printJson({ assignment });
    else console.log(ok(`${ROLE_LABELS[role]}: ${describeAssignment(assignment)}`));
    return;
  }
  if (action === "unset") {
    if (!args[0]) throw new Error(`Usage: ${cmd("poke model unset <role>")}`);
    const role = parseRole(args[0]);
    await api.unset(role);
    if (opts.json) printJson({ role, unset: true });
    else console.log(ok(`${ROLE_LABELS[role]} is no longer set.`));
    return;
  }
  if (action)
    throw new Error(
      `Unknown action ${action}. Use ${cmd("poke model")}, ${cmd("poke model set")} or ${cmd("poke model unset")}.`,
    );

  const roles = await api.roles();
  if (opts.json) {
    printJson({ roles });
    return;
  }
  if (!isInteractive()) {
    console.log(table(roles.map((r) => [r.label, describeAssignment(r.assignment)])));
    return;
  }
  await modelMenu(ctx, api, roles);
}

/** The interactive flow of section 6.2: role → provider → model → reasoning (→ voice reasoning). */
export async function modelMenu(ctx: Context, api: ModelsApi, roles?: RoleRow[]): Promise<void> {
  roles ??= await api.roles();
  const byRole = new Map(roles.map((r) => [r.role, r]));
  const memoryHint = `chat: ${describeAssignment(byRole.get("memory.chat")?.assignment)} · embeddings: ${describeAssignment(byRole.get("memory.embeddings")?.assignment)}`;
  const choice = unwrap(
    await p.select<string>({
      message: "Which model do you want to change?",
      options: [
        ...(["poke", "agents", "sidechat"] as const).map((role) => ({
          value: role,
          label: ROLE_LABELS[role],
          hint: describeAssignment(byRole.get(role)?.assignment),
        })),
        { value: "memory", label: "Memory", hint: memoryHint },
        {
          value: "utility",
          label: ROLE_LABELS.utility,
          hint: describeAssignment(byRole.get("utility")?.assignment),
        },
      ],
    }),
  );
  let role: Role;
  if (choice === "memory") {
    role = unwrap(
      await p.select<Role>({
        message: "Which Memory model?",
        options: [
          {
            value: "memory.chat",
            label: "Chat model",
            hint: describeAssignment(byRole.get("memory.chat")?.assignment),
          },
          {
            value: "memory.embeddings",
            label: "Embedding model",
            hint: describeAssignment(byRole.get("memory.embeddings")?.assignment),
          },
        ],
      }),
    );
  } else {
    role = choice as Role;
  }
  const row = byRole.get(role)!;
  if (role === "memory.embeddings" && row.assignment) {
    p.log.warn("Changing the embedding model means Honcho has to re-embed everything (a Honcho reset).");
    if (!unwrap(await p.confirm({ message: "Change it anyway?", initialValue: false }))) return;
  }

  // provider: only those allowed for the role; the ones not logged in jump into `poke login`
  let provider = row.providers.length === 1 && row.providers[0]!.loggedIn ? row.providers[0]!.id : undefined;
  while (!provider) {
    const picked = unwrap(
      await p.select<string>({
        message: `Provider for ${row.label}`,
        options: row.providers.map((pr) => ({
          value: pr.id,
          label: pr.name,
          hint: pr.loggedIn ? (row.assignment?.provider === pr.id ? "current" : "") : "log in…",
        })),
      }),
    );
    const entry = row.providers.find((pr) => pr.id === picked)!;
    if (entry.loggedIn) {
      provider = picked;
      break;
    }
    const login = (await api.logins()).find((l) => l.id === entry.loginId);
    if (login && (await loginFlow(ctx, api, login))) {
      entry.loggedIn = true;
      provider = picked;
    }
  }

  const spin = p.spinner();
  spin.start(`Loading ${providerName(provider)} models`);
  const models = await api.models(provider);
  spin.stop(`${models.length} model${models.length === 1 ? "" : "s"}`);
  if (models.length === 0) {
    p.log.warn(`${providerName(provider)} doesn't offer any models Poke can use yet.`);
    return;
  }
  const modelId = unwrap(
    await p.autocomplete<string>({
      message: "Model (type to search)",
      maxItems: 12,
      ...(row.assignment?.provider === provider ? { initialValue: row.assignment.model } : {}),
      options: models.map((m) => ({
        value: m.id,
        label: m.name && m.name !== m.id ? `${m.id}  ${pc.dim(m.name)}` : m.id,
        hint: `${Math.round(m.contextWindow / 1000)}K context`,
      })),
    }),
  );
  const model = models.find((m) => m.id === modelId)!;
  const reasoning = await pickReasoning(model, `Reasoning level for ${row.label}`, row.assignment?.reasoning);
  const voiceReasoning =
    role === "poke"
      ? await pickReasoning(model, "Reasoning level for voice calls", row.assignment?.voiceReasoning)
      : undefined;

  const saved = await api.set(role, {
    provider,
    model: model.id,
    ...(reasoning ? { reasoning } : {}),
    ...(voiceReasoning ? { voiceReasoning } : {}),
  });
  p.log.success(ok(`${row.label}: ${describeAssignment(saved)}`));
  if (await ctx.online()) p.log.info(dim("Applied live; no restart needed."));
}

async function pickReasoning(
  model: ModelInfo,
  message: string,
  current?: string,
): Promise<string | undefined> {
  if (model.reasoningLevels.length === 0) return undefined;
  return unwrap(
    await p.select<string>({
      message,
      ...(current && model.reasoningLevels.includes(current) ? { initialValue: current } : {}),
      options: model.reasoningLevels.map((level) => ({ value: level, label: level })),
    }),
  );
}

// ── poke setup: steps 4 (logins) and 6 (models) ──────────────────────────────────────────────

registerSetupStep(
  {
    id: "logins",
    title: "Model provider logins",
    later: "poke login",
    async run(ctx) {
      const api = await modelsApi(ctx);
      if (
        !(await skipOrRun(
          "Log in to model providers (Claude subscription, Qwen Token Plan, Voyage)",
          "poke login",
        ))
      ) {
        return (await api.logins()).some((l) => l.loggedIn) ? [] : ["logins"];
      }
      for (;;) {
        const logins = await api.logins();
        const next = unwrap(
          await p.select<string>({
            message: "Log in to",
            options: [
              ...logins.map((l) => ({
                value: l.id,
                label: `${l.name}  ${l.loggedIn ? pc.green("✓ logged in") : pc.dim("not set")}`,
                hint: LOGIN_HELP[l.id] ?? "",
              })),
              { value: "done", label: "Done" },
            ],
          }),
        );
        if (next === "done") return logins.some((l) => l.loggedIn) ? [] : ["logins"];
        await loginFlow(
          ctx,
          api,
          logins.find((l) => l.id === next)!,
        );
      }
    },
  },
  "pair",
);

registerSetupStep(
  {
    id: "models",
    title: "Models per role",
    later: "poke model",
    async run(ctx) {
      const api = await modelsApi(ctx);
      if (!(await skipOrRun("Choose a model for each role (nothing is picked for you)", "poke model"))) {
        return (await api.roles()).some((r) => r.role === "poke" && r.assignment) ? [] : ["Poke model"];
      }
      for (;;) {
        await modelMenu(ctx, api);
        if (!unwrap(await p.confirm({ message: "Change another role?", initialValue: true }))) break;
      }
      const unset = (await api.roles()).filter((r) => !r.assignment).map((r) => `${r.label} model`);
      return unset;
    },
  },
  "pair",
);
