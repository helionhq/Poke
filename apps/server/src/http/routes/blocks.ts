import { BlockActionRequest, BlockActionResponse, BlockResponse } from "@poke/contracts";
import type { FastifyInstance } from "fastify";
import { requireStack, type Services } from "../../services.js";
import { IdParams, route, type Surface } from "../route.js";

/** Blocks (section 9): read one, act on one. */
export function registerBlockRoutes(app: FastifyInstance, s: Services, _surface: Surface): void {
  route(
    app,
    { method: "GET", url: "/v1/blocks/:id", auth: "device", params: IdParams, response: BlockResponse },
    ({ params }) => ({ block: requireStack(s).blocks.get(params.id) }),
  );
  route(
    app,
    {
      method: "POST",
      url: "/v1/blocks/:id/actions",
      auth: "device",
      params: IdParams,
      body: BlockActionRequest,
      response: BlockActionResponse,
      summary: "Act on a block (idempotent by clientActionId)",
    },
    ({ params, body }) =>
      requireStack(s).blocks.act(params.id, {
        action: body.action,
        payload: body.payload,
        clientActionId: body.clientActionId,
      }),
  );
}
