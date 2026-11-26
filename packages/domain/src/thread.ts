import type { AttachmentId, BlockId, MessageId, SideChatId, TraceId } from "./ids.js";

export type MessageRole = "user" | "poke" | "system";

export type AttachmentKind = "image" | "file" | "audio" | "scan";

export interface TextPart {
  type: "text";
  text: string;
}

export interface AttachmentPart {
  type: "attachment";
  attachmentId: AttachmentId;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}

/** A block lives in the blocks table; the part points to it. Clients receive it hydrated. */
export interface BlockPart {
  type: "block";
  blockId: BlockId;
}

/** A trace (executor steps serving a reply) rendered above the reply it belongs to. */
export interface TracePart {
  type: "trace";
  traceId: TraceId;
}

export type MessagePart = TextPart | AttachmentPart | BlockPart | TracePart;

export type MessageStatus = "streaming" | "complete" | "failed";

export type MessageOrigin =
  | { kind: "user" }
  | { kind: "share" }
  | { kind: "voice" }
  | { kind: "turn" }
  | { kind: "routine"; routineId: string; runId: string; late?: boolean }
  | { kind: "system"; reason: SystemNoteReason };

export type SystemNoteReason =
  "no_model" | "rate_limited" | "login_expired" | "provider_error" | "compacted" | "skill_installed" | "info";

export interface Message {
  id: MessageId;
  /** "main" for the thread; side chats are never persisted but use the same shape in memory. */
  scope: "main" | `sidechat:${SideChatId}`;
  role: MessageRole;
  parts: MessagePart[];
  status: MessageStatus;
  origin: MessageOrigin;
  /** Idempotency key from the client outbox (user messages). */
  clientMessageId?: string;
  /** Reply / quote target. */
  replyTo?: { messageId: MessageId; excerpt: string };
  createdAt: number;
  updatedAt: number;
}

export function messageText(message: Pick<Message, "parts">): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** Light markdown only: Poke replies may use **bold** and [links](url). */
export function stripLightMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}
