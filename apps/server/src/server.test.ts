import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@poke/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { buildApp } from "./http/app.js";
import { resolvePaths } from "./infra/paths.js";
import { createKernel, type Kernel } from "./kernel.js";
import { servicesFromKernel, type Services } from "./services.js";

let home: string;
let kernel: Kernel;
let services: Services;
let app: FastifyInstance;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "poke-test-"));
  kernel = createKernel({ paths: resolvePaths(home) });
  services = servicesFromKernel(kernel, { version: "test" });
  app = await buildApp(services, "public");
});

afterEach(async () => {
  await app.close();
  kernel.close();
  rmSync(home, { recursive: true, force: true });
});

async function pair(): Promise<string> {
  const { code } = kernel.devices.issuePairingCode();
  const res = await app.inject({
    method: "POST",
    url: "/v1/pair",
    payload: { code, deviceName: "iPhone", platform: "ios" },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { token: string; device: { tokenHash?: string } };
  expect(body.device.tokenHash).toBeUndefined();
  return body.token;
}

function multipart(fields: Record<string, string>, file?: { name: string; mime: string; data: Buffer }) {
  const boundary = "----poke" + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

// 1x1 PNG
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082",
  "hex",
);

describe("poke-server core", () => {
  it("answers health without auth and rejects unauthenticated thread reads", async () => {
    const icon = await app.inject({ url: "/icon.png" });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/jpeg");
    expect((await app.inject({ url: "/v1/health" })).json()).toMatchObject({ ok: true, protocol: 1 });
    expect((await app.inject({ url: "/v1/thread" })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/v1/thread", headers: { authorization: "Bearer nope" } })).statusCode,
    ).toBe(401);
  });

  it("pairs once per code and rejects reused or wrong codes", async () => {
    const { code } = kernel.devices.issuePairingCode();
    const first = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, deviceName: "a", platform: "ios" },
    });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code, deviceName: "b", platform: "ios" },
    });
    expect(again.statusCode).toBe(401);
    const lower = kernel.devices.issuePairingCode().code.toLowerCase().replace("-", "");
    const normalized = await app.inject({
      method: "POST",
      url: "/v1/pair",
      payload: { code: lower, deviceName: "c", platform: "ios" },
    });
    expect(normalized.statusCode).toBe(200);
  });

  it("revoked tokens stop working", async () => {
    const token = await pair();
    const auth = { authorization: `Bearer ${token}` };
    const devices = (await app.inject({ url: "/v1/devices", headers: auth })).json() as {
      devices: { id: string }[];
    };
    await app.inject({ method: "DELETE", url: `/v1/devices/${devices.devices[0]!.id}`, headers: auth });
    expect((await app.inject({ url: "/v1/thread", headers: auth })).statusCode).toBe(401);
  });

  it("sends messages idempotently and pages the thread", async () => {
    const auth = { authorization: `Bearer ${await pair()}` };
    const send = (text: string, clientMessageId: string) =>
      app.inject({
        method: "POST",
        url: "/v1/thread/messages",
        headers: auth,
        payload: { text, clientMessageId },
      });
    const a = (await send("hello there", "client-0001")).json() as {
      message: { id: string };
      duplicate: boolean;
    };
    const b = (await send("hello there", "client-0001")).json() as {
      message: { id: string };
      duplicate: boolean;
    };
    expect(b.duplicate).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    await send("second", "client-0002");
    const page = (await app.inject({ url: "/v1/thread/messages?limit=10", headers: auth })).json() as {
      messages: { id: string }[];
      latestSeq: number;
    };
    expect(page.messages).toHaveLength(2);
    expect(page.latestSeq).toBe(2);
    expect((await send("", "client-0003")).statusCode).toBe(400);
    const search = (await app.inject({ url: "/v1/search?q=hello", headers: auth })).json() as {
      hits: unknown[];
    };
    expect(search.hits).toHaveLength(1);
  });

  it("uploads an image, reads its size and attaches it to a message", async () => {
    const auth = { authorization: `Bearer ${await pair()}` };
    const form = multipart({}, { name: "dot.png", mime: "image/png", data: PNG });
    const up = await app.inject({
      method: "POST",
      url: "/v1/attachments",
      headers: { ...auth, ...form.headers },
      payload: form.payload,
    });
    expect(up.statusCode).toBe(200);
    const { attachment } = up.json() as {
      attachment: { id: string; kind: string; width: number; path: string };
    };
    expect(attachment).toMatchObject({ kind: "image", width: 1 });
    expect(attachment.path).toMatch(/^attachments\/\d{4}\/\d{2}\//);
    const sent = await app.inject({
      method: "POST",
      url: "/v1/thread/messages",
      headers: auth,
      payload: { text: "", clientMessageId: "client-img-1", attachmentIds: [attachment.id] },
    });
    expect(sent.statusCode).toBe(200);
    const download = await app.inject({ url: `/v1/attachments/${attachment.id}`, headers: auth });
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.rawPayload.equals(PNG)).toBe(true);
  });

  it("share tokens can only share", async () => {
    const auth = { authorization: `Bearer ${await pair()}` };
    const { token } = (
      await app.inject({ method: "POST", url: "/v1/devices/share-token", headers: auth })
    ).json() as {
      token: string;
    };
    const share = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: "/v1/thread", headers: share })).statusCode).toBe(403);
    const json = await app.inject({
      method: "POST",
      url: "/v1/share",
      headers: share,
      payload: { url: "https://example.com/a", note: "read later" },
    });
    expect(json.statusCode).toBe(200);
    expect((json.json() as { deepLink: string }).deepLink).toMatch(/^poke:\/\/thread\?message=msg_/);
    const form = multipart({ note: "look" }, { name: "dot.png", mime: "image/png", data: PNG });
    const multi = await app.inject({
      method: "POST",
      url: "/v1/share",
      headers: { ...share, ...form.headers },
      payload: form.payload,
    });
    expect(multi.statusCode).toBe(200);
    // Shortcuts sends a shared link as a small text file: it becomes the message text.
    const linkForm = multipart(
      {},
      { name: "URL.txt", mime: "text/plain", data: Buffer.from("https://example.com/b\n") },
    );
    const link = await app.inject({
      method: "POST",
      url: "/v1/share",
      headers: { ...share, ...linkForm.headers },
      payload: linkForm.payload,
    });
    expect(link.statusCode).toBe(200);
    const page = (await app.inject({ url: "/v1/thread/messages", headers: auth })).json() as {
      messages: { parts: { type: string; text?: string }[]; origin: { kind: string } }[];
    };
    expect(page.messages.map((m) => m.origin.kind)).toEqual(["share", "share", "share"]);
    expect(page.messages[2]!.parts).toEqual([{ type: "text", text: "https://example.com/b" }]);
    expect(page.messages[0]!.parts[0]).toMatchObject({
      type: "text",
      text: "read later\n\nhttps://example.com/a",
    });
  });

  it("streams events over WebSocket and resumes from a seq", async () => {
    const token = await pair();
    const auth = { authorization: `Bearer ${token}` };
    await app.inject({
      method: "POST",
      url: "/v1/thread/messages",
      headers: auth,
      payload: { text: "one", clientMessageId: "ws-000001" },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = address.replace("http", "ws");

    const collect = (since: number, until: (frames: ServerFrame[]) => boolean, protocols?: string[]) =>
      new Promise<ServerFrame[]>((resolve, reject) => {
        const frames: ServerFrame[] = [];
        const ws = protocols
          ? new WebSocket(`${wsUrl}/v1/events?since=${since}`, protocols)
          : new WebSocket(`${wsUrl}/v1/events?since=${since}`, { headers: auth });
        ws.on("message", (raw) => {
          frames.push(JSON.parse(raw.toString()) as ServerFrame);
          if (until(frames)) {
            ws.close();
            resolve(frames);
          }
        });
        ws.on("error", reject);
        setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(frames)}`)), 5000);
      });

    const initial = await collect(0, (f) => f.some((x) => x.t === "snapshot"));
    expect(initial.map((f) => f.t)).toEqual(["hello", "event", "snapshot"]);

    // resume from the latest seq via the subprotocol token; a new message arrives live
    const latest = (initial[0] as { latestSeq: number }).latestSeq;
    const live = collect(latest, (f) => f.some((x) => x.t === "event"), ["poke.v1", `poke.bearer.${token}`]);
    await new Promise((r) => setTimeout(r, 150));
    await app.inject({
      method: "POST",
      url: "/v1/thread/messages",
      headers: auth,
      payload: { text: "two", clientMessageId: "ws-000002" },
    });
    const frames = await live;
    expect(frames.map((f) => f.t)).toEqual(["hello", "snapshot", "event"]);
    const event = frames[2] as { seq: number; event: { type: string } };
    expect(event.seq).toBe(latest + 1);
    expect(event.event.type).toBe("message.created");
  });
});
