import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, startServer, type RunningServer, type StatusReport } from "@poke/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminClient, AdminError } from "./admin.js";
import { pairingLink } from "./commands/devices.js";

let home: string;
let server: RunningServer;
let admin: AdminClient;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "poke-cli-"));
  server = await startServer({ paths: resolvePaths(home), port: 0 });
  admin = new AdminClient(server.services.paths.adminSocket);
});
afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

describe("admin socket", () => {
  it("answers status as the owner, without a token", async () => {
    expect(await admin.reachable()).toBe(true);
    const status = await admin.call<StatusReport>("GET", "/admin/status");
    expect(status.server.running).toBe(true);
    expect(status.models.every((m) => m.assignment === undefined)).toBe(true);
  });

  it("issues a pairing code the public API accepts", async () => {
    const issued = await admin.call<{ code: string; expiresAt: number; url: string }>(
      "POST",
      "/admin/pairing-code",
    );
    const link = pairingLink(issued, "https://fallback.invalid");
    const payload = JSON.parse(Buffer.from(link.split("d=")[1]!, "base64url").toString()) as {
      v: number;
      code: string;
      url: string;
    };
    expect(payload).toEqual({ v: 1, code: issued.code, url: "https://poke.arham.im" });
    const res = await fetch(`${server.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: payload.code, deviceName: "iPhone", platform: "ios" }),
    });
    expect(res.status).toBe(200);
  });

  it("validates settings and reports errors as AdminError", async () => {
    await admin.call("PUT", "/admin/settings", { key: "profile.timezone", value: "Europe/Lisbon" });
    const { settings } = await admin.call<{ settings: Record<string, unknown> }>("GET", "/admin/settings");
    expect(settings["profile.timezone"]).toBe("Europe/Lisbon");
    await expect(
      admin.call("PUT", "/admin/settings", { key: "context.window", value: 5 }),
    ).rejects.toBeInstanceOf(AdminError);
  });

  it("is not reachable from the public port", async () => {
    expect((await fetch(`${server.url}/admin/status`)).status).toBe(404);
  });
});
