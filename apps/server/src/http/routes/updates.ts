import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { DomainError } from "@poke/domain";
import type { FastifyInstance } from "fastify";
import { sideStoreSource, UpdateStore } from "../../infra/updates.js";
import type { Services } from "../../services.js";
import { route, type Surface } from "../route.js";

/**
 * Updates (brief section 23): the expo-updates protocol (v1) for JS updates, behind the device
 * token like every other route, and the SideStore source with its IPAs, which SideStore fetches
 * without credentials, so a long random path segment stands in for one.
 */
export function registerUpdateRoutes(app: FastifyInstance, s: Services, surface: Surface): void {
  const store = new UpdateStore(s.paths.updates);
  const baseUrl = () => (s.settings.get("public.url") ?? "").replace(/\/+$/, "");

  if (surface === "admin") {
    route(app, { method: "GET", url: "/admin/updates", auth: "admin" }, () => {
      let token = s.settings.get("sidestore.token");
      if (!token) {
        token = randomBytes(24).toString("base64url");
        s.settings.set("sidestore.token", token);
      }
      return {
        sourceUrl: `${baseUrl()}/sidestore/${token}/source.json`,
        releases: store.releases().map(({ file: _file, permissions: _p, ...r }) => r),
      };
    });
  }

  route(
    app,
    {
      method: "GET",
      url: "/v1/updates/manifest",
      auth: "device",
      summary: "expo-updates manifest (protocol 1)",
    },
    ({ req, reply }) => {
      const platform = header(req.headers["expo-platform"]);
      const runtimeVersion = header(req.headers["expo-runtime-version"]);
      if (platform !== "ios") throw new DomainError("invalid", "Only iOS updates are served");
      if (!runtimeVersion) throw new DomainError("invalid", "Missing expo-runtime-version");
      reply
        .header("expo-protocol-version", "1")
        .header("expo-sfv-version", "0")
        .header("cache-control", "private, max-age=0");
      const update = store.latest(runtimeVersion);
      // No update for this build: an empty answer (protocol 1 allows 204 with no body).
      if (!update) return reply.code(204).send();
      const manifest = store.manifest(
        update,
        (path) => `${baseUrl()}/v1/updates/assets/${path.split("/").map(encodeURIComponent).join("/")}`,
      );
      const boundary = `poke-${randomBytes(12).toString("hex")}`;
      const part = (name: string, body: unknown) =>
        `--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(body)}\r\n`;
      return reply
        .header("content-type", `multipart/mixed; boundary=${boundary}`)
        .send(
          `${part("manifest", manifest)}${part("extensions", { assetRequestHeaders: {} })}--${boundary}--\r\n`,
        );
    },
  );

  route(app, { method: "GET", url: "/v1/updates/assets/*", auth: "device" }, ({ req, reply }) => {
    const path = decodeURIComponent((req.params as { "*": string })["*"] ?? "");
    const asset = store.assetFile(path);
    if (!asset) throw new DomainError("not_found", "No such update file");
    return reply
      .header("content-type", asset.contentType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .send(createReadStream(asset.file));
  });

  // SideStore can't send credentials: the token in the path is the only check (constant time).
  const tokenOk = (given: string) => {
    const want = s.settings.get("sidestore.token");
    if (!want) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  route(
    app,
    { method: "GET", url: "/sidestore/:token/source.json", auth: "none", summary: "SideStore source" },
    ({ req, reply }) => {
      const { token } = req.params as { token: string };
      if (!tokenOk(token)) throw new DomainError("not_found", "Not found");
      return reply
        .header("cache-control", "no-cache")
        .send(sideStoreSource({ baseUrl: baseUrl(), token, releases: store.releases() }));
    },
  );

  route(
    app,
    { method: "GET", url: "/sidestore/:token/:file", auth: "none", summary: "An IPA for SideStore" },
    ({ req, reply }) => {
      const { token, file } = req.params as { token: string; file: string };
      if (!tokenOk(token)) throw new DomainError("not_found", "Not found");
      const build = /^Poke-[0-9A-Za-z.]+-([0-9]{1,9})\.ipa$/.exec(file)?.[1];
      const release = build ? store.release(build) : undefined;
      if (!release) throw new DomainError("not_found", "Not found");
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(release.size))
        .header("content-disposition", `attachment; filename="${file}"`)
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(createReadStream(release.file));
    },
  );
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
