import { card } from "./card.js";
import type { BlockKind, BlockView, Transition } from "./kind.js";
import {
  action,
  BlockActionError,
  choices,
  connectRequest,
  draft,
  memoryNote,
  secretRequest,
  toolApproval,
} from "./kinds.js";

export * from "./kind.js";
export * from "./kinds.js";
export { card, CARD_LIMITS, CardNode, CardProps, cardProblems, actionIdsOf, plainText } from "./card.js";

/** Bumped when a kind is added or a kind's version changes. */
export const BLOCK_CATALOG_VERSION = 1;

/**
 * Every block kind the server can create. Adding one: a schema with props and slots that mirror
 * the Doop component, a state machine, an agent tool, and a renderer in the app (docs/BLOCKS.md).
 */
export const CATALOG = {
  choices,
  draft,
  action,
  secret_request: secretRequest,
  connect_request: connectRequest,
  tool_approval: toolApproval,
  memory_note: memoryNote,
  card,
} as const;

export type BlockKindName = keyof typeof CATALOG;
export const BLOCK_KINDS = Object.keys(CATALOG) as BlockKindName[];

export function kindOf(name: string): BlockKind | undefined {
  return Object.hasOwn(CATALOG, name) ? (CATALOG[name as BlockKindName] as unknown as BlockKind) : undefined;
}

export interface NewBlock {
  kind: string;
  v: number;
  props: Record<string, unknown>;
  state: string;
  fallback: string;
}

/** Validate props for a kind and give the block its first state. Throws BlockActionError. */
export function newBlock(kindName: string, props: unknown): NewBlock {
  const kind = kindOf(kindName);
  if (!kind) throw new BlockActionError(`Unknown block kind ${kindName}`);
  const parsed = kind.props.safeParse(props);
  if (!parsed.success) throw new BlockActionError(issues(parsed.error));
  const view = { props: parsed.data as Record<string, unknown>, state: kind.initial };
  return {
    kind: kind.kind,
    v: kind.v,
    props: view.props,
    state: kind.initial,
    fallback: kind.fallbackText(view),
  };
}

export interface AppliedAction {
  transition: Transition<Record<string, unknown>>;
  /** The payload held a secret: don't store, log or echo it. */
  sensitive: boolean;
  /** Validated payload. */
  payload: unknown;
  fallback: string;
}

/**
 * Run an action against a block's state machine. Throws BlockActionError when the kind or action
 * is unknown, the caller may not send it, the state doesn't allow it, or the payload is invalid.
 */
export function applyAction(
  block: { kind: string; v: number } & BlockView,
  actionName: string,
  payload: unknown,
  by: "user" | "system",
): AppliedAction {
  const kind = kindOf(block.kind);
  if (!kind || kind.v !== block.v)
    throw new BlockActionError(`This server can't act on ${block.kind} v${block.v} blocks`);
  const def = Object.hasOwn(kind.actions, actionName) ? kind.actions[actionName] : undefined;
  if (!def || (def.by === "system" && by === "user"))
    throw new BlockActionError(`${block.kind} has no action ${actionName}`);
  if (!def.from.includes(block.state)) throw new BlockActionError(`It's already ${block.state}`);
  const parsed = def.payload.safeParse(payload ?? {});
  if (!parsed.success)
    throw new BlockActionError(def.sensitive ? "That value can't be saved" : issues(parsed.error));
  const transition = def.apply(block, parsed.data);
  if (!kind.states.includes(transition.state))
    throw new Error(`${block.kind}.${actionName} moved to unknown state ${transition.state}`);
  const after = {
    props: transition.props ?? block.props,
    state: transition.state,
    ...(transition.resolution ? { resolution: transition.resolution } : {}),
  };
  return {
    transition,
    sensitive: Boolean(def.sensitive),
    payload: parsed.data,
    fallback: kind.fallbackText(after),
  };
}

export function isTerminal(block: { kind: string; state: string }): boolean {
  return kindOf(block.kind)?.terminal.includes(block.state) ?? true;
}

/** Whether a system action exists for the block in its current state (e.g. expire). */
export function canApply(block: { kind: string; state: string }, actionName: string): boolean {
  const def = kindOf(block.kind)?.actions[actionName];
  return Boolean(def && def.from.includes(block.state));
}

export function fallbackText(block: { kind: string } & BlockView): string {
  const kind = kindOf(block.kind);
  return kind ? kind.fallbackText(block) : `[${block.kind}]`;
}

export function searchText(block: { kind: string; props: Record<string, unknown> }): string {
  return kindOf(block.kind)?.searchText?.(block.props) ?? "";
}

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 6)
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ");
}
