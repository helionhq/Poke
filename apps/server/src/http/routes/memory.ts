import { MemoryRecallQuery, MemoryRecallResponse, MemoryStatus } from "@poke/contracts";
import type { FastifyInstance } from "fastify";
import { finishMemory, prepareMemory } from "../../infra/honcho-deploy.js";
import { prepareTunnel } from "../../infra/maintenance.js";
import { requireStack, type Services } from "../../services.js";
import { route, type Surface } from "../route.js";

/** Section 13: the Search screen's "From your history"; the deploy steps `poke memory setup` drives. */
export function registerMemoryRoutes(app: FastifyInstance, s: Services, surface: Surface): void {
  route(
    app,
    {
      method: "GET",
      url: "/v1/memory/recall",
      auth: "device",
      query: MemoryRecallQuery,
      response: MemoryRecallResponse,
    },
    async ({ query }) => ({ answer: await requireStack(s).memory.recall(query.q) }),
  );

  if (surface !== "admin") return;
  route(app, { method: "GET", url: "/admin/memory", auth: "admin", response: MemoryStatus }, () =>
    memoryStatus(s),
  );
  // The tunnel token goes into cloudflared.env (0600) here, inside the server, like the Honcho env.
  route(app, { method: "POST", url: "/admin/tunnel/prepare", auth: "admin" }, () => ({
    ready: prepareTunnel({ system: requireStack(s).vault.system, paths: s.paths }),
  }));
  route(app, { method: "POST", url: "/admin/memory/prepare", auth: "admin" }, () => {
    const layout = prepareMemory({ system: requireStack(s).vault.system, paths: s.paths });
    return { layout };
  });
  route(
    app,
    { method: "POST", url: "/admin/memory/finish", auth: "admin", response: MemoryStatus },
    async () => {
      const stack = requireStack(s);
      finishMemory(stack.vault.system, s.clock.now());
      await stack.memory.refreshCard();
      return memoryStatus(s);
    },
  );
}

function memoryStatus(s: Services) {
  const stack = requireStack(s);
  return {
    available: stack.memory.available(),
    deployed: stack.vault.system.has("honcho.jwt"),
    chatModel: stack.models.get("memory.chat")?.model ?? null,
    embeddingsModel: stack.models.get("memory.embeddings")?.model ?? null,
    gateway: stack.modelGateway.address() ?? null,
  };
}
