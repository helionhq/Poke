import {
  type Attachment,
  type AttachmentPart,
  type Block,
  type Clock,
  DomainError,
  type IdGenerator,
  type Message,
  type MessageOrigin,
  type MessagePart,
  type PersistedEvent,
  type Repositories,
  type SystemNoteReason,
  type Trace,
  messageText,
  stripLightMarkdown,
} from "@poke/domain";
import { searchText as blockSearchText } from "@poke/blocks";
import type { EventHub } from "./core/hub.js";

export interface IncomingUserMessage {
  text: string;
  clientMessageId: string;
  attachmentIds: string[];
  replyTo?: string;
  origin?: MessageOrigin;
  context?: { timezone?: string; location?: string };
}

export type UserMessageHandler = (message: Message, context?: IncomingUserMessage["context"]) => void;

export interface HydratedPage {
  messages: Message[];
  blocks: Block[];
  traces: Trace[];
  before?: string;
}

const EXCERPT = 140;

/** The one never-ending thread: persistence, paging, hydration, system notes. */
export class ThreadService {
  #onUserMessage: UserMessageHandler | undefined;

  constructor(
    private readonly repos: Repositories,
    private readonly hub: EventHub,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** The interaction orchestrator registers here (milestone 3). */
  onUserMessage(handler: UserMessageHandler): void {
    this.#onUserMessage = handler;
  }

  /** Save a user message (idempotent on clientMessageId) and hand it to Poke. */
  send(input: IncomingUserMessage): { message: Message; duplicate: boolean } {
    const existing = this.repos.messages.byClientMessageId(input.clientMessageId);
    if (existing) return { message: existing, duplicate: true };

    const attachments = input.attachmentIds.map((id) => {
      const attachment = this.repos.attachments.get(id);
      if (!attachment) throw new DomainError("invalid", `Unknown attachment ${id}`);
      return attachment;
    });
    if (input.text.trim() === "" && attachments.length === 0) {
      throw new DomainError("invalid", "A message needs text or an attachment");
    }

    const now = this.clock.now();
    const parts: MessagePart[] = attachments.map(attachmentPart);
    if (input.text.trim() !== "") parts.push({ type: "text", text: input.text });

    const message: Message = {
      id: this.ids.next("msg"),
      scope: "main",
      role: "user",
      parts,
      status: "complete",
      origin: input.origin ?? { kind: "user" },
      clientMessageId: input.clientMessageId,
      createdAt: now,
      updatedAt: now,
    };
    if (input.replyTo) {
      const target = this.repos.messages.get(input.replyTo);
      if (target) message.replyTo = { messageId: target.id, excerpt: excerpt(messageText(target)) };
    }

    this.hub.commit(() => {
      this.repos.messages.save(message);
      if (attachments.length > 0)
        this.repos.attachments.attachToMessage(
          attachments.map((a) => a.id),
          message.id,
        );
      return { result: message, events: [{ type: "message.created", message }] };
    });
    this.#onUserMessage?.(message, input.context);
    return { message, duplicate: false };
  }

  /** A short system note in the thread ("Poke has no model yet…"). */
  systemNote(text: string, reason: SystemNoteReason): Message {
    const now = this.clock.now();
    const message: Message = {
      id: this.ids.next("msg"),
      scope: "main",
      role: "system",
      parts: [{ type: "text", text }],
      status: "complete",
      origin: { kind: "system", reason },
      createdAt: now,
      updatedAt: now,
    };
    this.hub.commit(() => {
      this.repos.messages.save(message);
      return { result: message, events: [{ type: "message.created", message }] };
    });
    return message;
  }

  /** Create or update a Poke/system message and publish it (used by the interaction orchestrator). */
  saveMessage(message: Message, kind: "created" | "updated", extra: PersistedEvent[] = []): void {
    this.hub.commit(() => {
      this.repos.messages.save(message, this.#extraSearchText(message));
      return {
        result: undefined,
        events: [{ type: kind === "created" ? "message.created" : "message.updated", message }, ...extra],
      };
    });
  }

  get(id: string): Message | undefined {
    return this.repos.messages.get(id);
  }

  page(opts: { before?: string; limit: number }): HydratedPage {
    const page = this.repos.messages.page(opts);
    return { ...this.hydrate(page.messages), ...(page.before ? { before: page.before } : {}) };
  }

  around(id: string, radius: number): HydratedPage {
    const messages = this.repos.messages.around(id, radius);
    if (messages.length === 0) throw new DomainError("not_found", "Message not found");
    return this.hydrate(messages);
  }

  hydrate(messages: Message[]): { messages: Message[]; blocks: Block[]; traces: Trace[] } {
    const blocks: Block[] = [];
    const traces: Trace[] = [];
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "block") {
          const block = this.repos.blocks.get(part.blockId);
          if (block) blocks.push(block);
        } else if (part.type === "trace") {
          const trace = this.repos.traces.get(part.traceId);
          if (trace) traces.push(trace);
        }
      }
    }
    return { messages, blocks, traces };
  }

  info(): { since?: number; messageCount: number } {
    const first = this.repos.messages.first();
    return { messageCount: this.repos.messages.count(), ...(first ? { since: first.createdAt } : {}) };
  }

  /** Block text (draft bodies, card contents, titles) is indexed with its message so Search finds it. */
  #extraSearchText(message: Message): string | undefined {
    const texts: string[] = [];
    for (const part of message.parts) {
      if (part.type !== "block") continue;
      const block = this.repos.blocks.get(part.blockId);
      if (!block) continue;
      const text = blockSearchText(block).trim();
      if (text) texts.push(text);
    }
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
}

function attachmentPart(attachment: Attachment): AttachmentPart {
  const part: AttachmentPart = {
    type: "attachment",
    attachmentId: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
  };
  if (attachment.width !== undefined) part.width = attachment.width;
  if (attachment.height !== undefined) part.height = attachment.height;
  return part;
}

function excerpt(text: string): string {
  const flat = stripLightMarkdown(text).replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
}
