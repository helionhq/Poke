import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "./infra/paths.js";
import { createKernel, type Kernel } from "./kernel.js";

let home: string;
let kernel: Kernel;
let now = 1_800_000_000_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "poke-kernel-"));
  kernel = createKernel({ paths: resolvePaths(home), clock: { now: () => now } });
});
afterEach(() => {
  kernel.close();
  rmSync(home, { recursive: true, force: true });
});

describe("devices", () => {
  it("expires pairing codes and rate-limits guessing", () => {
    const { code } = kernel.devices.issuePairingCode();
    now += 11 * 60 * 1000;
    expect(() => kernel.devices.pair({ code, deviceName: "x", platform: "ios" })).toThrow(/expired|invalid/i);
    for (let i = 0; i < 9; i++) {
      expect(() => kernel.devices.pair({ code: "AAAAA-AAAAA", deviceName: "x", platform: "ios" })).toThrow();
    }
    const fresh = kernel.devices.issuePairingCode();
    expect(() => kernel.devices.pair({ code: fresh.code, deviceName: "x", platform: "ios" })).toThrow(
      /too many/i,
    );
    now += 11 * 60 * 1000;
    const later = kernel.devices.issuePairingCode();
    expect(kernel.devices.pair({ code: later.code, deviceName: "x", platform: "ios" }).device.scope).toBe(
      "full",
    );
  });

  it("stores only token hashes", () => {
    const { token, device } = kernel.devices.createLocalToken("laptop");
    expect(JSON.stringify(kernel.db.devices.list())).not.toContain(token);
    expect(kernel.devices.authenticate(token)?.id).toBe(device.id);
    expect(kernel.devices.authenticate(`${token}x`)).toBeUndefined();
  });
});

describe("thread", () => {
  it("emits one persisted event per new message and none for duplicates", () => {
    const seen: string[] = [];
    kernel.hub.subscribe((f) => f.kind === "event" && seen.push(f.stored.event.type));
    kernel.thread.send({ text: "hi", clientMessageId: "abcdefgh1", attachmentIds: [] });
    kernel.thread.send({ text: "hi", clientMessageId: "abcdefgh1", attachmentIds: [] });
    expect(seen).toEqual(["message.created"]);
    expect(kernel.hub.since(0, 10)).toHaveLength(1);
  });

  it("builds a reply excerpt", () => {
    const { message: first } = kernel.thread.send({
      text: "the **first** message",
      clientMessageId: "abcdefgh2",
      attachmentIds: [],
    });
    const { message } = kernel.thread.send({
      text: "replying",
      clientMessageId: "abcdefgh3",
      attachmentIds: [],
      replyTo: first.id,
    });
    expect(message.replyTo).toMatchObject({ messageId: first.id, excerpt: "the first message" });
  });

  it("rejects unknown attachments", () => {
    expect(() =>
      kernel.thread.send({ text: "", clientMessageId: "abcdefgh4", attachmentIds: ["att_missing"] }),
    ).toThrow();
  });
});
