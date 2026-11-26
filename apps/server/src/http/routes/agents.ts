import { parseRole } from "@poke/application";
import { ALL_ROLES, DomainError, PROVIDERS, ROLE_LABELS } from "@poke/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStack, type Services } from "../../services.js";
import { IdParams, route, type Surface } from "../route.js";

const TasksQuery = z.object({ all: z.enum(["true", "false"]).optional() });
const SideChatSend = z.object({ text: z.string().min(1).max(20_000) });
const LoginParams = z.object({ id: z.string().min(1).max(40) });
const LoginBody = z.object({ secret: z.string().min(1).max(4096) });
const RoleParams = z.object({ role: z.string().min(1).max(40) });
const ProviderParams = z.object({ provider: z.string().min(1).max(80) });
const SetModelBody = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoning: z.string().min(1).optional(),
  voiceReasoning: z.string().min(1).optional(),
});

/** Context, tasks, side chats and (admin only) logins and models. */
export function registerAgentRoutes(app: FastifyInstance, s: Services, surface: Surface): void {
  // ── context (section 5.4) ──────────────────────────────────────────────────────────────────
  route(
    app,
    {
      method: "GET",
      url: "/v1/context",
      auth: "device",
      summary: "Poke's context: tokens, budget, last compaction",
    },
    () => requireStack(s).poke.context(),
  );
  route(
    app,
    { method: "POST", url: "/v1/context/compact", auth: "device", summary: "Compact Poke's context now" },
    async () => ({
      compaction: (await requireStack(s).poke.compactNow()) ?? null,
    }),
  );

  // ── tasks ──────────────────────────────────────────────────────────────────────────────────
  route(app, { method: "GET", url: "/v1/tasks", auth: "device", query: TasksQuery }, ({ query }) => ({
    tasks: requireStack(s).agents.list(query.all === "true"),
  }));
  route(app, { method: "GET", url: "/v1/tasks/:id", auth: "device", params: IdParams }, ({ params }) => {
    const task = s.db.tasks.get(params.id);
    if (!task) throw new DomainError("not_found", "Task not found");
    return { task, steps: s.db.steps.byTask(task.id) };
  });
  route(
    app,
    { method: "POST", url: "/v1/tasks/:id/cancel", auth: "device", params: IdParams },
    async ({ params }) => ({
      task: await requireStack(s).agents.cancel(params.id),
    }),
  );

  // ── models (read-only for the app: it shows "not set" notices) ─────────────────────────────
  route(app, { method: "GET", url: "/v1/models", auth: "device" }, () => ({
    roles: ALL_ROLES.map((role) => {
      const assignment = s.db.models.get(role);
      return { role, label: ROLE_LABELS[role], ...(assignment ? { assignment } : {}) };
    }),
  }));

  // ── side chats (5.6): in memory only ───────────────────────────────────────────────────────
  route(app, { method: "GET", url: "/v1/sidechats", auth: "device" }, () => ({
    sideChats: requireStack(s).sidechats.list(),
  }));
  route(app, { method: "POST", url: "/v1/sidechats", auth: "device" }, () => ({
    sideChat: requireStack(s).sidechats.open(),
  }));
  route(app, { method: "GET", url: "/v1/sidechats/:id", auth: "device", params: IdParams }, ({ params }) => ({
    sideChat: requireStack(s).sidechats.get(params.id),
  }));
  route(
    app,
    {
      method: "POST",
      url: "/v1/sidechats/:id/messages",
      auth: "device",
      params: IdParams,
      body: SideChatSend,
    },
    async ({ params, body }) => ({
      message: await requireStack(s).sidechats.post(params.id, body),
    }),
  );
  route(
    app,
    { method: "POST", url: "/v1/sidechats/:id/cancel", auth: "device", params: IdParams },
    async ({ params }) => {
      await requireStack(s).sidechats.cancel(params.id);
    },
  );
  route(
    app,
    { method: "POST", url: "/v1/sidechats/:id/send-to-poke", auth: "device", params: IdParams },
    async ({ params }) => ({
      message: await requireStack(s).sidechats.sendToPoke(params.id),
    }),
  );
  route(
    app,
    { method: "DELETE", url: "/v1/sidechats/:id", auth: "device", params: IdParams },
    async ({ params }) => {
      await requireStack(s).sidechats.close(params.id);
    },
  );

  if (surface !== "admin") return;

  // ── logins and models: the CLI only ────────────────────────────────────────────────────────
  route(app, { method: "GET", url: "/admin/logins", auth: "admin" }, () => ({
    logins: requireStack(s).logins.list(),
  }));
  route(
    app,
    { method: "POST", url: "/admin/logins/:id", auth: "admin", params: LoginParams, body: LoginBody },
    async ({ params, body }) => {
      const stack = requireStack(s);
      await stack.logins.login(params.id, body.secret);
      return { login: stack.logins.list().find((l) => l.id === params.id) };
    },
  );
  route(
    app,
    { method: "DELETE", url: "/admin/logins/:id", auth: "admin", params: LoginParams },
    ({ params }) => ({
      removed: requireStack(s).logins.logout(params.id),
    }),
  );

  route(app, { method: "GET", url: "/admin/models", auth: "admin" }, () => {
    const stack = requireStack(s);
    return {
      roles: ALL_ROLES.map((role) => {
        const assignment = stack.models.get(role);
        return {
          role,
          label: ROLE_LABELS[role],
          ...(assignment ? { assignment } : {}),
          providers: stack.models.providersFor(role).map((p) => ({
            id: p.id,
            name: p.name,
            loginId: p.loginId,
            loggedIn: stack.logins.isLoggedIn(p.id),
          })),
        };
      }),
    };
  });
  route(
    app,
    { method: "GET", url: "/admin/models/providers/:provider", auth: "admin", params: ProviderParams },
    async ({ params }) => {
      if (!PROVIDERS.some((p) => p.id === params.provider))
        throw new DomainError("not_found", `Unknown provider ${params.provider}`);
      return { models: await requireStack(s).models.models(params.provider) };
    },
  );
  route(
    app,
    { method: "PUT", url: "/admin/models/:role", auth: "admin", params: RoleParams, body: SetModelBody },
    async ({ params, body }) => ({
      assignment: await requireStack(s).models.set({
        role: params.role,
        provider: body.provider,
        model: body.model,
        ...(body.reasoning ? { reasoning: body.reasoning } : {}),
        ...(body.voiceReasoning ? { voiceReasoning: body.voiceReasoning } : {}),
      }),
    }),
  );
  route(
    app,
    { method: "DELETE", url: "/admin/models/:role", auth: "admin", params: RoleParams },
    ({ params }) => {
      requireStack(s).models.unset(parseRole(params.role));
    },
  );
}
