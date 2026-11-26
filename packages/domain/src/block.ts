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
  | { type: "approval"; approvalId: string };
