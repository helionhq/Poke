import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ImageProxy } from "../../infra/image-proxy.js";
import type { Services } from "../../services.js";
import { route, type Surface } from "../route.js";

const ImageQuery = z.object({ src: z.string().min(9).max(2000) });
const DomainParams = z.object({ domain: z.string().min(3).max(253) });
/** Poke's mark, public so Bark can show it next to pushes. */
const ICON = createRequire(import.meta.url).resolve("@poke/ui-tokens/assets/agent-mark.jpg");

/**
 * Third-party images for the app (card images, site logos), fetched by the server so the phone
 * never contacts those hosts. See infra/image-proxy.ts for the guards.
 */
export function registerMediaRoutes(
  app: FastifyInstance,
  s: Services,
  _surface: Surface,
  proxy = new ImageProxy({ cacheDir: join(s.paths.data, "cache", "images") }),
): void {
  route(
    app,
    { method: "GET", url: "/icon.png", auth: "none", summary: "Poke's mark (push icons)" },
    ({ reply }) =>
      reply
        .header("content-type", "image/jpeg")
        .header("cache-control", "public, max-age=86400")
        .header("x-content-type-options", "nosniff")
        .send(createReadStream(ICON)),
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/images",
      auth: "device",
      query: ImageQuery,
      summary: "An image from a card, via Poke",
    },
    async ({ query, reply }) => {
      const image = await proxy.image(query.src);
      return reply
        .header("content-type", image.type)
        .header("cache-control", "private, max-age=604800")
        .header("x-content-type-options", "nosniff")
        .send(image.body);
    },
  );
  route(
    app,
    {
      method: "GET",
      url: "/v1/logos/:domain",
      auth: "device",
      params: DomainParams,
      summary: "A site's logo, via Poke",
    },
    async ({ params, reply }) => {
      const image = await proxy.logo(params.domain);
      return reply
        .header("content-type", image.type)
        .header("cache-control", "private, max-age=604800")
        .header("x-content-type-options", "nosniff")
        .send(image.body);
    },
  );
}
