import type { BlockId, MessageId, TaskId } from "./ids.js";

/**
 * A block is an interactive message part. The catalog (kinds, schemas, state machines) lives in
 * @poke/blocks; the domain only knows the generic envelope and who is waiting on it.
 */
export interface Block {
  id: BlockId;
  kind: string;
  /** Schema version of the kind. */
  v: number;
  props: Record<string, unknown>;
  state: string;
  /** What the user decided (never contains secret values). */
  resolution?: Record<string, unknown>;
  /** Plain text for notifications, the digest and clients that don't know this kind or version. */
  fallback?: string;
  owner: BlockOwner;
  messageId: MessageId;
  scope: "main" | `sidechat:${string}`;
  createdAt: number;
  updatedAt: number;
}

export type BlockOwner =
  /** Poke created it with a block tool and gets the resolution as a structured event. */
  | { type: "poke" }
  /** Built by the server from an executor need; the parked task is signalled on resolution. */
  | { type: "task"; taskId: TaskId; needId: string }
  /** An Executor-gated tool call waiting for a decision (any agent). */
  | { type: "approval"; approvalId: string; /** The agent waiting on it. */ taskId?: string };

/** A block action already applied, so a retried request (same clientActionId) gets the same answer. */
export interface BlockActionRecord {
  clientActionId: string;
  blockId: string;
  action: string;
  /** What the action answered (e.g. a sign-in URL). Never a payload, which may hold a secret. */
  result?: Record<string, unknown>;
  createdAt: number;
}
