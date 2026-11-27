import {
  NotificationTestResponse,
  RoutineDetail,
  RoutineList,
  RoutinePatchRequest,
  RoutineRunResponse,
  SkillDetail,
  SkillList,
  SkillPatchRequest,
} from "@poke/contracts";
import type { Routine } from "@poke/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireStack, type Services } from "../../services.js";
import { route, type Surface } from "../route.js";

const IdParams = z.object({ id: z.string().min(1).max(64) });
const NameParams = z.object({ name: z.string().min(1).max(64) });

/** Sections 14, 15 and 18: the Routines and Skills screens, and Bark's test push. */
export function registerRoutineRoutes(app: FastifyInstance, s: Services, surface: Surface): void {
  const view = (routine: Routine) => ({
    ...routine,
    scheduleText: requireStack(s).routines.describe(routine),
  });

  route(app, { method: "GET", url: "/v1/routines", auth: "device", response: RoutineList }, () => ({
    routines: requireStack(s).routines.list().map(view),
  }));
  route(
    app,
    { method: "GET", url: "/v1/routines/:id", auth: "device", params: IdParams, response: RoutineDetail },
    ({ params }) => {
      const { routine, runs } = requireStack(s).routines.get(params.id);
      return { routine: view(routine), runs };
    },
  );
  route(
    app,
    {
      method: "PATCH",
      url: "/v1/routines/:id",
      auth: "device",
      params: IdParams,
      body: RoutinePatchRequest,
      response: RoutineDetail,
    },
    ({ params, body }) => {
      const routines = requireStack(s).routines;
      routines.update(params.id, body);
      const { routine, runs } = routines.get(params.id);
      return { routine: view(routine), runs };
    },
  );
  route(
    app,
    { method: "DELETE", url: "/v1/routines/:id", auth: "device", params: IdParams },
    ({ params }) => {
      requireStack(s).routines.delete(params.id);
      return { deleted: true };
    },
  );
  route(
    app,
    {
      method: "POST",
      url: "/v1/routines/:id/run",
      auth: "device",
      params: IdParams,
      response: RoutineRunResponse,
    },
    async ({ params }) => ({ run: await requireStack(s).routines.runNow(params.id) }),
  );

  route(app, { method: "GET", url: "/v1/skills", auth: "device", response: SkillList }, () => ({
    skills: requireStack(s).skills.list(),
  }));
  route(
    app,
    { method: "GET", url: "/v1/skills/:name", auth: "device", params: NameParams, response: SkillDetail },
    async ({ params }) => ({ skill: await requireStack(s).skills.get(params.name) }),
  );
  route(
    app,
    {
      method: "PATCH",
      url: "/v1/skills/:name",
      auth: "device",
      params: NameParams,
      body: SkillPatchRequest,
      response: SkillDetail,
    },
    ({ params, body }) => ({ skill: requireStack(s).skills.setEnabled(params.name, body.enabled) }),
  );
  route(
    app,
    { method: "DELETE", url: "/v1/skills/:name", auth: "device", params: NameParams },
    async ({ params }) => {
      await requireStack(s).skills.remove(params.name);
      return { deleted: true };
    },
  );

  if (surface !== "admin") return;
  // `poke setup`'s Bark step (and `poke doctor`, milestone 12).
  route(
    app,
    { method: "POST", url: "/admin/notifications/test", auth: "admin", response: NotificationTestResponse },
    async () => {
      await requireStack(s).notifications.test();
      return { ok: true as const };
    },
  );
}
