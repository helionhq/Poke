import { createReadStream } from "node:fs";
import { ShareResponse, UploadResponse } from "@poke/contracts";
import { type Attachment, DomainError } from "@poke/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Services } from "../../services.js";
import { IdParams, route, type Surface } from "../route.js";

const KindHint = z.enum(["image", "file", "audio", "scan"]).optional();

export function registerAttachmentRoutes(app: FastifyInstance, s: Services, _surface: Surface): void {
  route(
    app,
    {
      method: "POST",
      url: "/v1/attachments",
      auth: "device",
      rawBody: true,
      response: UploadResponse,
      summary: "Upload a file (multipart, field `file`); reference it from a message",
    },
    async ({ req }) => {
      const file = await req.file();
      if (!file) throw new DomainError("invalid", "Expected a multipart `file` field");
      const data = new Uint8Array(await file.toBuffer());
      const kindField = (file.fields.kind as { value?: unknown } | undefined)?.value;
      const kindHint = KindHint.parse(typeof kindField === "string" ? kindField : undefined);
      const attachment = await s.attachments.store({
        name: file.filename,
        mime: file.mimetype,
        data,
        origin: "user",
        ...(kindHint ? { kindHint } : {}),
      });
      return { attachment };
    },
  );

  route(
    app,
    { method: "GET", url: "/v1/attachments/:id", auth: "device", params: IdParams },
    ({ params, reply }) => {
      const attachment = s.attachments.get(params.id);
      return reply
        .header("content-type", attachment.mime)
        .header("content-length", attachment.size)
        .header("cache-control", "private, max-age=31536000, immutable")
        .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
        .send(createReadStream(s.attachments.absolutePath(attachment)));
    },
  );

  route(
    app,
    {
      method: "POST",
      url: "/v1/share",
      auth: "share",
      rawBody: true,
      response: ShareResponse,
      summary: "Share to Poke (iOS Shortcut): text, URLs, images, files; JSON or multipart",
    },
    async ({ req }) => {
      const { text, attachments } = await readShare(req, s);
      const { message } = s.thread.send({
        text,
        clientMessageId: `share_${s.ids.next("msg")}`,
        attachmentIds: attachments.map((a) => a.id),
        origin: { kind: "share" },
      });
      return { messageId: message.id, deepLink: `poke://thread?message=${message.id}` };
    },
  );
}

const ShareJson = z.object({
  text: z.string().optional(),
  url: z.union([z.string(), z.array(z.string())]).optional(),
  urls: z.array(z.string()).optional(),
  note: z.string().optional(),
});

async function readShare(
  req: FastifyRequest,
  s: Services,
): Promise<{ text: string; attachments: Attachment[] }> {
  const pieces: string[] = [];
  const attachments: Attachment[] = [];
  if (req.isMultipart()) {
    let note = "";
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const data = new Uint8Array(await part.toBuffer());
        if (data.byteLength === 0) continue;
        // Shortcuts sends shared text and links as a small text file: put those in the message.
        if (isSharedText(part.mimetype, data)) {
          const value = new TextDecoder().decode(data).trim();
          if (value) pieces.push(value);
          continue;
        }
        attachments.push(
          await s.attachments.store({
            name: part.filename || "shared",
            mime: part.mimetype,
            data,
            origin: "share",
          }),
        );
      } else {
        const value = typeof part.value === "string" ? part.value.trim() : "";
        if (!value) continue;
        if (part.fieldname === "note") note = value;
        else pieces.push(value);
      }
    }
    if (note) pieces.unshift(note);
  } else {
    const body = ShareJson.parse(req.body ?? {});
    if (body.note) pieces.push(body.note);
    if (body.text) pieces.push(body.text);
    const urls = [...(Array.isArray(body.url) ? body.url : body.url ? [body.url] : []), ...(body.urls ?? [])];
    pieces.push(...urls);
  }
  const text = pieces.join("\n\n");
  if (!text && attachments.length === 0) throw new DomainError("invalid", "Nothing to share");
  return { text, attachments };
}

/** A shared snippet rather than a document: plain text or a link list, at most 8 KB. */
export function isSharedText(mime: string, data: Uint8Array): boolean {
  const type = mime.split(";")[0]?.trim().toLowerCase();
  return (type === "text/plain" || type === "text/uri-list") && data.byteLength <= 8192;
}
