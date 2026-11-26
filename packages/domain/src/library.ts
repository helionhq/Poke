import type { AttachmentId, MessageId } from "./ids.js";
import type { AttachmentKind } from "./thread.js";

/** A stored file: chat attachment, share, voice note, or a deliverable from Poke. */
export interface Attachment {
  id: AttachmentId;
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  /** Path relative to the library root (attachments/YYYY/MM/<id>-<name>). */
  path: string;
  width?: number;
  height?: number;
  durationMs?: number;
  origin: "user" | "share" | "poke";
  messageId?: MessageId;
  createdAt: number;
}

export type LibraryFilter = "all" | "photos" | "files" | "from_poke";
