import { createReadStream } from "node:fs";
import { LibraryList, LibraryQuery, WorkspaceListing, WorkspaceQuery } from "@poke/contracts";
import type { FastifyInstance } from "fastify";
import { WorkspaceBrowser } from "../../infra/workspace-browser.js";
import type { Services } from "../../services.js";
import { route, type Surface } from "../route.js";

/** The Library (brief §16): every attachment, and Poke's workspace as folders. */
export function registerLibraryRoutes(app: FastifyInstance, s: Services, _surface: Surface): void {
  let browser: WorkspaceBrowser | undefined;
  const workspace = () => (browser ??= new WorkspaceBrowser(s.paths.workspace));

  route(
    app,
    {
      method: "GET",
      url: "/v1/library",
      auth: "device",
      query: LibraryQuery,
      response: LibraryList,
      summary: "Attachments: all, photos, files or from Poke",
    },
    ({ query }) => ({
      attachments: s.db.attachments.list({
        filter: query.filter,
        limit: query.limit,
        ...(query.q ? { query: query.q } : {}),
        ...(query.before !== undefined ? { before: query.before } : {}),
      }),
    }),
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/library/workspace",
      auth: "device",
      query: WorkspaceQuery,
      response: WorkspaceListing,
      summary: "A folder in Poke's workspace",
    },
    ({ query }) => workspace().list(query.path),
  );

  route(
    app,
    {
      method: "GET",
      url: "/v1/library/workspace/file",
      auth: "device",
      query: WorkspaceQuery,
      summary: "Download a file from Poke's workspace",
    },
    async ({ query, reply }) => {
      const file = await workspace().file(query.path);
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", file.size)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "private, no-cache")
        .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`)
        .send(createReadStream(file.abs));
    },
  );
}
