import {
  SearchQuery,
  SendMessageRequest,
  SendMessageResponse,
  ThreadInfo,
  ThreadPage,
  ThreadPageQuery,
} from "@poke/contracts";
import { DomainError } from "@poke/domain";
import type { FastifyInstance } from "fastify";
import { requireStack, type Services } from "../../services.js";
import { IdParams, route, type Surface } from "../route.js";

export function registerThreadRoutes(app: FastifyInstance, s: Services, _surface: Surface): void {
  route(app, { method: "GET", url: "/v1/thread", auth: "device", response: ThreadInfo }, () => ({
    ...s.thread.info(),
    latestSeq: s.hub.latestSeq(),
    pokeModelSet: s.db.models.get("poke") !== undefined,
    ...(s.stack ? { vaultCount: s.stack.vault.list().length } : {}),
  }));

  route(
    app,
    {
      method: "GET",
      url: "/v1/thread/messages",
      auth: "device",
      query: ThreadPageQuery,
      response: ThreadPage,
    },
    ({ query }) => {
      const latestSeq = s.hub.latestSeq();
      if (query.around) return { ...s.thread.around(query.around, Math.ceil(query.limit / 2)), latestSeq };
      const page = s.thread.page({ limit: query.limit, ...(query.before ? { before: query.before } : {}) });
      return { ...page, latestSeq };
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/thread/messages",
      auth: "device",
      body: SendMessageRequest,
      response: SendMessageResponse,
      summary: "Send a message to Poke (idempotent on clientMessageId)",
    },
    ({ body }) =>
      s.thread.send({
        text: body.text,
        clientMessageId: body.clientMessageId,
        attachmentIds: body.attachmentIds,
        ...(body.replyTo ? { replyTo: body.replyTo } : {}),
        ...(body.context ? { context: body.context } : {}),
      }),
  );
  route(
    app,
    {
      method: "POST",
      url: "/v1/thread/stop",
      auth: "device",
      summary: "Stop Poke's current turn and the agents it started",
    },
    () => requireStack(s).poke.stop(),
  );

  route(app, { method: "GET", url: "/v1/messages/:id", auth: "device", params: IdParams }, ({ params }) => {
    const message = s.thread.get(params.id);
    if (!message) throw new DomainError("not_found", "Message not found");
    return { message, ...s.thread.hydrate([message]) };
  });

  route(app, { method: "GET", url: "/v1/traces/:id", auth: "device", params: IdParams }, ({ params }) => {
    const trace = s.db.traces.get(params.id);
    if (!trace) throw new DomainError("not_found", "Trace not found");
    const tasks = trace.taskIds.map((id) => s.db.tasks.get(id)).filter((t) => t !== undefined);
    return { trace, steps: s.db.steps.byTrace(trace.id), tasks };
  });

  route(app, { method: "GET", url: "/v1/search", auth: "device", query: SearchQuery }, ({ query }) => {
    const hits = s.db.messages.search({
      query: query.q,
      limit: query.limit,
      ...(query.before !== undefined ? { before: query.before } : {}),
      ...(query.after !== undefined ? { after: query.after } : {}),
    });
    const out = [];
    for (const hit of hits) {
      const links = [...hit.highlight.matchAll(/https?:\/\/[^\s)»]+/g)].map((m) => m[0]);
      const photo = hit.message.parts.find((p) => p.type === "attachment" && p.kind === "image");
      const kind = photo
        ? "photo"
        : links.length > 0
          ? "link"
          : hit.message.parts.some((p) => p.type === "trace")
            ? "task"
            : "message";
      if (query.filter === "messages" && kind !== "message") continue;
      if (query.filter === "links" && kind !== "link") continue;
      if (query.filter === "photos" && kind !== "photo") continue;
      if (query.filter === "tasks" && kind !== "task") continue;
      out.push({
        messageId: hit.message.id,
        role: hit.message.role,
        kind,
        highlight: hit.highlight,
        createdAt: hit.message.createdAt,
        ...(links[0] ? { url: links[0] } : {}),
        ...(photo && photo.type === "attachment" ? { attachmentId: photo.attachmentId } : {}),
      });
    }
    return { hits: out };
  });
}
