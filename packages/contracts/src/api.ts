import { z } from "zod";
import { Attachment, Block, Device, Message, Step, Task, Trace } from "./entities.js";

export const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ── Health / pairing ───────────────────────────────────────────────────────

export const HealthResponse = z.object({
  ok: z.boolean(),
  version: z.string(),
  protocol: z.number(),
  uptimeSec: z.number(),
});

export const PairRequest = z.object({
  code: z.string().min(4).max(64),
  deviceName: z.string().min(1).max(80),
  platform: z.enum(["ios", "web", "cli", "shortcut"]),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({ token: z.string(), device: Device });
export type PairResponse = z.infer<typeof PairResponse>;

/** What the QR code holds: `poke://pair?d=<base64url(JSON)>`. */
export const PairingPayload = z.object({
  v: z.literal(1),
  url: z.url(),
  code: z.string(),
  /** Optional Cloudflare Access service-token headers for the client to send. */
  access: z.object({ clientId: z.string(), clientSecret: z.string() }).optional(),
});
export type PairingPayload = z.infer<typeof PairingPayload>;

// ── Thread ────────────────────────────────────────────────────────────────

export const ThreadPageQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  around: z.string().optional(),
});

/** Normalised: blocks and traces referenced by the page's parts come alongside. */
export const ThreadPage = z.object({
  messages: z.array(Message),
  blocks: z.array(Block),
  traces: z.array(Trace),
  before: z.string().optional(),
  latestSeq: z.number(),
});
export type ThreadPage = z.infer<typeof ThreadPage>;

export const ThreadInfo = z.object({
  since: z.number().optional(),
  messageCount: z.number(),
  latestSeq: z.number(),
  pokeModelSet: z.boolean(),
});
export type ThreadInfo = z.infer<typeof ThreadInfo>;

export const SendMessageRequest = z.object({
  text: z.string().max(100_000).default(""),
  clientMessageId: z.string().min(8).max(100),
  attachmentIds: z.array(z.string()).max(20).default([]),
  replyTo: z.string().optional(),
  /** Per-turn facts from the device (location, local time) — never cached in the prompt. */
  context: z.object({ timezone: z.string().optional(), location: z.string().optional() }).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({ message: Message, duplicate: z.boolean() });

export const SearchQuery = z.object({
  q: z.string().min(1),
  filter: z.enum(["all", "messages", "tasks", "links", "photos"]).default("all"),
  before: z.coerce.number().optional(),
  after: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  history: z.coerce.boolean().default(true),
});

export const SearchResponse = z.object({
  history: z.object({ answer: z.string(), mentions: z.number() }).optional(),
  hits: z.array(
    z.object({
      messageId: z.string(),
      role: z.enum(["user", "poke", "system"]),
      kind: z.enum(["message", "task", "link", "photo"]),
      highlight: z.string(),
      createdAt: z.number(),
      url: z.string().optional(),
      attachmentId: z.string().optional(),
    }),
  ),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const TraceDetail = z.object({ trace: Trace, steps: z.array(Step), tasks: z.array(Task) });

// ── Attachments ───────────────────────────────────────────────────────────

export const UploadResponse = z.object({ attachment: Attachment });

export const ShareResponse = z.object({ messageId: z.string(), deepLink: z.string() });

// ── Devices ───────────────────────────────────────────────────────────────

export const DeviceList = z.object({ devices: z.array(Device) });

export const ShareTokenResponse = z.object({ token: z.string(), device: Device });

// ── blocks (section 9) ───────────────────────────────────────────────────────────────────────

/**
 * An action on a block. `clientActionId` makes it idempotent: a retry gets the first answer.
 * A secret_request `save` payload holds the secret; the server writes it to the vault and never
 * stores, logs or echoes it.
 */
export const BlockActionRequest = z.object({
  action: z.string().min(1).max(40),
  payload: z.record(z.string(), z.unknown()).optional(),
  clientActionId: z.string().min(8).max(80),
});
export type BlockActionRequest = z.infer<typeof BlockActionRequest>;

export const BlockActionResponse = z.object({
  block: Block,
  /** e.g. `{url}` to open for a connect_request `connect`. */
  result: z.record(z.string(), z.unknown()).optional(),
  duplicate: z.boolean(),
});
export type BlockActionResponse = z.infer<typeof BlockActionResponse>;

export const BlockResponse = z.object({ block: Block });
