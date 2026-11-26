import {
  type Attachment,
  type AttachmentKind,
  type AttachmentRepository,
  type Clock,
  type CryptoPort,
  DomainError,
  type FileStore,
  type IdGenerator,
} from "@poke/domain";
import { imageSize } from "./core/image-size.js";

export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;

export interface StoreInput {
  name: string;
  mime: string;
  data: Uint8Array;
  origin: Attachment["origin"];
  kindHint?: AttachmentKind;
}

/** Chat attachments live under ~/poke/library/attachments/YYYY/MM/ with metadata in poke.db. */
export class AttachmentService {
  constructor(
    private readonly repo: AttachmentRepository,
    private readonly files: FileStore,
    private readonly crypto: CryptoPort,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async store(input: StoreInput): Promise<Attachment> {
    if (input.data.byteLength === 0) throw new DomainError("invalid", "Empty file");
    if (input.data.byteLength > MAX_ATTACHMENT_BYTES) throw new DomainError("invalid", "File is too large");
    const id = this.ids.next("att");
    const now = new Date(this.clock.now());
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const safe = safeFileName(input.name) || "file";
    const path = `attachments/${yyyy}/${mm}/${id}-${safe}`;
    await this.files.write(path, input.data);
    const kind = input.kindHint ?? kindFromMime(input.mime);
    const attachment: Attachment = {
      id,
      kind,
      name: input.name.slice(0, 200) || safe,
      mime: input.mime || "application/octet-stream",
      size: input.data.byteLength,
      sha256: this.crypto.sha256Hex(input.data),
      path,
      origin: input.origin,
      createdAt: now.getTime(),
    };
    if (kind === "image") {
      const size = imageSize(input.data);
      if (size) {
        attachment.width = size.width;
        attachment.height = size.height;
      }
    }
    this.repo.save(attachment);
    return attachment;
  }

  get(id: string): Attachment {
    const attachment = this.repo.get(id);
    if (!attachment) throw new DomainError("not_found", "Attachment not found");
    return attachment;
  }

  absolutePath(attachment: Attachment): string {
    return this.files.absolute(attachment.path);
  }

  async read(attachment: Attachment): Promise<Uint8Array> {
    return this.files.read(attachment.path);
  }
}

export function kindFromMime(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

export function safeFileName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "")
    .slice(0, 100);
}
