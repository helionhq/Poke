import { publicDevice } from "@poke/application";
import {
  DeviceList,
  HealthResponse,
  PairRequest,
  PairResponse,
  PROTOCOL_VERSION,
  ShareTokenResponse,
} from "@poke/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ed25519Key } from "../../infra/vault-proof.js";
import type { Services } from "../../services.js";
import { IdParams, openApiDocument, route, type Surface } from "../route.js";
import { stackStatus } from "../../stack.js";
import { buildStatus } from "../../status.js";

export function registerCoreRoutes(app: FastifyInstance, s: Services, surface: Surface): void {
  route(app, { method: "GET", url: "/v1/health", auth: "none", response: HealthResponse }, () => ({
    ok: true,
    version: s.version,
    protocol: PROTOCOL_VERSION,
    uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
  }));

  route(app, { method: "GET", url: "/v1/openapi.json", auth: "none" }, () => openApiDocument(s.version));

  route(
    app,
    {
      method: "POST",
      url: "/v1/pair",
      auth: "none",
      body: PairRequest,
      response: PairResponse,
      summary: "Exchange a pairing code for a device token",
    },
    ({ body }) => {
      if (body.vaultKey) ed25519Key(body.vaultKey); // a malformed key is a 400, before the code is spent
      const { token, device } = s.devices.pair(body);
      s.log.info({ device: device.id, name: device.name }, "device paired");
      return { token, device: publicDevice(device) };
    },
  );

  route(app, { method: "GET", url: "/v1/devices", auth: "device", response: DeviceList }, () => ({
    devices: s.devices.list().map(publicDevice),
  }));

  route(
    app,
    { method: "DELETE", url: "/v1/devices/:id", auth: "device", params: IdParams },
    ({ params }) => ({
      device: publicDevice(s.devices.revoke(params.id)),
    }),
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/devices/share-token",
      auth: "device",
      response: ShareTokenResponse,
      summary: "Mint a scoped token that can only POST /v1/share",
    },
    () => {
      const { token, device } = s.devices.createShareToken();
      return { token, device: publicDevice(device) };
    },
  );

  if (surface === "admin") {
    route(app, { method: "GET", url: "/admin/status", auth: "admin" }, () =>
      buildStatus(
        s,
        { running: true, version: s.version, uptimeSec: Math.round((Date.now() - s.startedAt) / 1000) },
        s.stack ? [stackStatus(s.stack)] : [],
      ),
    );

    route(app, { method: "POST", url: "/admin/pairing-code", auth: "admin" }, () => {
      const issued = s.devices.issuePairingCode();
      return { ...issued, url: s.settings.get("public.url") };
    });

    route(
      app,
      {
        method: "POST",
        url: "/admin/devices/local-token",
        auth: "admin",
        body: z.object({ name: z.string().min(1) }),
      },
      ({ body }) => {
        const { token, device } = s.devices.createLocalToken(body.name);
        return { token, device: publicDevice(device) };
      },
    );

    route(app, { method: "GET", url: "/admin/settings", auth: "admin" }, () => ({
      settings: s.settings.all(),
    }));

    route(
      app,
      {
        method: "PUT",
        url: "/admin/settings",
        auth: "admin",
        body: z.object({ key: z.string(), value: z.unknown() }),
      },
      ({ body }) => {
        if (body.value === null) s.settings.unset(body.key);
        else s.settings.set(body.key, body.value);
        return { settings: s.settings.all() };
      },
    );
  }
}
