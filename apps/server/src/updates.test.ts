import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./http/app.js";
import type { OtaManifest } from "./infra/updates.js";
import { resolvePaths } from "./infra/paths.js";
import { createKernel, type Kernel } from "./kernel.js";
import { servicesFromKernel } from "./services.js";

const RUNTIME = "6a8f711c5ad06e51456916c7fac392aefe8f0918";
const BUNDLE = Buffer.from("console.log('hello from an update')");
const FONT = Buffer.from("not really a font");

let home: string;
let kernel: Kernel;
let app: FastifyInstance;
let admin: FastifyInstance;
let token: string;

/** An `expo export` as `poke update` leaves it (Windows paths in metadata.json, like a real one). */
function writeExport(dir: string, createdAt: number) {
  mkdirSync(join(dir, "_expo", "static", "js", "ios"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "_expo", "static", "js", "ios", "entry-abc.hbc"), BUNDLE);
  writeFileSync(join(dir, "assets", "629142e9d264355129ad45763caa52e0"), FONT);
  writeFileSync(
    join(dir, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: {
          bundle: "_expo/static/js/ios/entry-abc.hbc",
          assets: [{ path: "assets\\629142e9d264355129ad45763caa52e0", ext: "ttf" }],
        },
      },
    }),
  );
  writeFileSync(join(dir, "expoConfig.json"), JSON.stringify({ name: "Poke", version: "1.0.0" }));
  writeFileSync(join(dir, "update.json"), JSON.stringify({ createdAt, commit: "abcdef1234567" }));
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "poke-updates-"));
  kernel = createKernel({ paths: resolvePaths(home) });
  kernel.settings.set("public.url", "https://poke.example");
  const services = servicesFromKernel(kernel, { version: "test" });
  app = await buildApp(services, "public");
  admin = await buildApp(services, "admin");
  const { code } = kernel.devices.issuePairingCode();
  token = (
    await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, deviceName: "iPhone", platform: "ios" },
    })
  ).json().token;
});

afterEach(async () => {
  await app.close();
  await admin.close();
  kernel.close();
  rmSync(home, { recursive: true, force: true });
});

const expoHeaders = (runtime = RUNTIME) => ({
  authorization: `Bearer ${token}`,
  "expo-platform": "ios",
  "expo-runtime-version": runtime,
  "expo-protocol-version": "1",
  accept: "multipart/mixed,application/expo+json,application/json",
});

function manifestFrom(body: string, contentType: string) {
  const boundary = /boundary=([^;]+)/.exec(contentType)![1]!;
  const parts = body.split(`--${boundary}`).filter((p) => p.includes("content-disposition"));
  const named = Object.fromEntries(
    parts.map((p) => [/name="([^"]+)"/.exec(p)![1]!, JSON.parse(p.slice(p.indexOf("\r\n\r\n") + 4).trim())]),
  );
  return named as { manifest: OtaManifest; extensions: Record<string, unknown> };
}

describe("OTA updates (expo-updates protocol 1)", () => {
  it("answers 204 when there's no update for this build", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/updates/manifest", headers: expoHeaders() });
    expect(res.statusCode).toBe(204);
    expect(res.headers["expo-protocol-version"]).toBe("1");
    expect(res.headers["expo-sfv-version"]).toBe("0");
  });

  it("serves the newest update as a multipart manifest whose hashes match the files", async () => {
    writeExport(join(kernel.paths.updates, "ota", RUNTIME, "1000-old"), 1000);
    writeExport(join(kernel.paths.updates, "ota", RUNTIME, "2000-new"), 2000);
    const res = await app.inject({ method: "GET", url: "/v1/updates/manifest", headers: expoHeaders() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, max-age=0");
    const { manifest, extensions } = manifestFrom(res.body, String(res.headers["content-type"]));
    expect(extensions).toEqual({ assetRequestHeaders: {} });
    expect(manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(manifest.createdAt).toBe(new Date(2000).toISOString());
    expect(manifest.runtimeVersion).toBe(RUNTIME);
    expect(manifest.extra).toMatchObject({ expoClient: { name: "Poke" }, commit: "abcdef1234567" });
    expect(manifest.launchAsset).toMatchObject({
      contentType: "application/javascript",
      hash: createHash("sha256").update(BUNDLE).digest("base64url"),
    });
    expect(manifest.launchAsset.url).toContain("https://poke.example/v1/updates/assets/");
    expect(manifest.launchAsset.url).toContain("2000-new");
    expect(manifest.assets[0]).toMatchObject({ contentType: "font/ttf", fileExtension: ".ttf" });

    // The asset URLs serve the bytes the hashes describe, behind the device token.
    for (const asset of [manifest.launchAsset, ...manifest.assets]) {
      const url = String(asset.url).replace("https://poke.example", "");
      const file = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      expect(file.statusCode).toBe(200);
      expect(createHash("sha256").update(file.rawPayload).digest("base64url")).toBe(asset.hash);
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("needs the device token and refuses paths outside the update", async () => {
    writeExport(join(kernel.paths.updates, "ota", RUNTIME, "1000-a"), 1000);
    const { authorization: _a, ...anonymous } = expoHeaders();
    expect(
      (await app.inject({ method: "GET", url: "/v1/updates/manifest", headers: anonymous })).statusCode,
    ).toBe(401);
    const escape = await app.inject({
      method: "GET",
      url: `/v1/updates/assets/${RUNTIME}/1000-a/..%2F..%2F..%2Fdata%2Fpoke.db`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(escape.statusCode).toBe(404);
    const otherRuntime = await app.inject({
      method: "GET",
      url: "/v1/updates/manifest",
      headers: expoHeaders("../../etc"),
    });
    expect(otherRuntime.statusCode).toBe(204);
  });
});

describe("SideStore source", () => {
  it("lists native builds behind a secret path and serves the IPA", async () => {
    const dir = join(kernel.paths.updates, "ipa", "412");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Poke.ipa"), Buffer.alloc(1234, 1));
    writeFileSync(
      join(dir, "release.json"),
      JSON.stringify({
        version: "1.0.0",
        buildVersion: "412",
        date: "2026-11-27T10:00:00Z",
        commit: "abcdef1234567",
        minOSVersion: "17.0",
        permissions: {
          entitlements: ["keychain-access-groups"],
          privacy: { NSMicrophoneUsageDescription: "Talk to Poke." },
        },
      }),
    );
    const info = (await admin.inject({ method: "GET", url: "/admin/updates" })).json();
    expect(info.releases).toEqual([expect.objectContaining({ buildVersion: "412", size: 1234 })]);
    const sourcePath = String(info.sourceUrl).replace("https://poke.example", "");
    expect(sourcePath).toMatch(/^\/sidestore\/[A-Za-z0-9_-]{32,}\/source\.json$/);

    const source = await app.inject({ method: "GET", url: sourcePath });
    expect(source.statusCode).toBe(200);
    const appEntry = source.json().apps[0];
    expect(appEntry).toMatchObject({
      bundleIdentifier: "im.arham.poke",
      appPermissions: { privacy: { NSMicrophoneUsageDescription: "Talk to Poke." } },
    });
    expect(appEntry.versions[0]).toMatchObject({ version: "1.0.0", buildVersion: "412", size: 1234 });

    const ipaPath = String(appEntry.versions[0].downloadURL).replace("https://poke.example", "");
    const ipa = await app.inject({ method: "GET", url: ipaPath });
    expect(ipa.statusCode).toBe(200);
    expect(ipa.rawPayload.byteLength).toBe(1234);

    const wrong = sourcePath.replace(/sidestore\/[^/]+/, "sidestore/wrongwrongwrongwrongwrongwrongwrong");
    expect((await app.inject({ method: "GET", url: wrong })).statusCode).toBe(404);
  });
});
