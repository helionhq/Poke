/** Branded string ids. Ids are opaque, prefixed and time-sortable (see IdGenerator). */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type MessageId = string;
export type BlockId = string;
export type TaskId = string;
export type StepId = string;
export type TraceId = string;
export type RoutineId = string;
export type SkillName = string;
export type VaultName = string;
export type AttachmentId = string;
export type DeviceId = string;
export type SideChatId = string;

/** The one main thread. There is never another persisted thread. */
export const MAIN_THREAD = "main" as const;
export type ThreadId = typeof MAIN_THREAD;

export type IdPrefix =
  | "msg"
  | "blk"
  | "tsk"
  | "stp"
  | "trc"
  | "rtn"
  | "run"
  | "att"
  | "dev"
  | "sc"
  | "apr"
  | "rul"
  | "cmp"
  | "acc"
  | "mcp"
  | "nte";

export interface IdGenerator {
  /** A new id like `msg_01JD…`: prefix + time-ordered, collision-resistant suffix. */
  next(prefix: IdPrefix): string;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
