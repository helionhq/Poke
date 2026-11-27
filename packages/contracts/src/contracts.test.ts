import { describe, expect, it } from "vitest";
import {
  ClientFrame,
  coerceSetting,
  Message,
  PersistedEvent,
  SendMessageRequest,
  ServerFrame,
} from "./index.js";

describe("contracts", () => {
  it("round-trips a message and its event", () => {
    const message = {
      id: "msg_1",
      scope: "main",
      role: "poke",
      parts: [
        { type: "text", text: "On it." },
        { type: "block", blockId: "blk_1" },
        { type: "trace", traceId: "trc_1" },
      ],
      status: "complete",
      origin: { kind: "turn" },
      createdAt: 1,
      updatedAt: 1,
    } as const;
    expect(Message.parse(message)).toEqual(message);
    const event = PersistedEvent.parse({ type: "message.created", message });
    expect(ServerFrame.parse({ t: "event", seq: 1, at: 1, event })).toMatchObject({ t: "event" });
    expect(Message.safeParse({ ...message, scope: "elsewhere" }).success).toBe(false);
    expect(Message.safeParse({ ...message, scope: "sidechat:sc_1" }).success).toBe(true);
  });

  it("defaults and validates send requests and client frames", () => {
    expect(SendMessageRequest.parse({ clientMessageId: "abcdefgh" })).toMatchObject({
      text: "",
      attachmentIds: [],
    });
    expect(SendMessageRequest.safeParse({ clientMessageId: "short" }).success).toBe(false);
    expect(ClientFrame.parse({ t: "ping", presence: "background" }).presence).toBe("background");
  });

  it("coerces CLI setting values", () => {
    expect(coerceSetting("context.window", "300000")).toBe(300000);
    expect(coerceSetting("update.auto", "on")).toBe(true);
    expect(coerceSetting("app.wallpaper", "dunes")).toBe("dunes");
    expect(() => coerceSetting("context.window", "10")).toThrow(/context.window: .*100000/);
    expect(() => coerceSetting("app.wallpaper", "mars")).toThrow();
  });
});
