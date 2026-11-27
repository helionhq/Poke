import { ApprovalRuleList, PendingApprovals } from "@poke/contracts";
import type { FastifyInstance } from "fastify";
import { requireStack, type Services } from "../../services.js";
import { IdParams, route, type Surface } from "../route.js";

/** Always-allow rules (integration detail and approval rules screens) and what's waiting. */
export function registerApprovalRoutes(app: FastifyInstance, s: Services, _surface: Surface): void {
  route(
    app,
    {
      method: "GET",
      url: "/v1/approvals",
      auth: "device",
      response: PendingApprovals,
      summary: "Waiting for an OK",
    },
    () => ({
      approvals: requireStack(s)
        .approvals.pending()
        .map(({ args: _args, argsHash: _hash, resume: _resume, requester: _who, ...rest }) => rest),
    }),
  );
  route(
    app,
    { method: "GET", url: "/v1/approvals/rules", auth: "device", response: ApprovalRuleList },
    () => ({ rules: requireStack(s).approvals.rules() }),
  );
  route(
    app,
    { method: "DELETE", url: "/v1/approvals/rules/:id", auth: "device", params: IdParams },
    ({ params }) => {
      requireStack(s).approvals.deleteRule(params.id);
      return { deleted: true };
    },
  );
}
