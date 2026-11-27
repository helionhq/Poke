import { z } from "zod";

/** What a block looks like to the catalog: its props, where it is in its life, what was decided. */
export interface BlockView<P = Record<string, unknown>> {
  props: P;
  state: string;
  resolution?: Record<string, unknown>;
}

export interface Transition<P> {
  state: string;
  resolution?: Record<string, unknown>;
  /** Replaces the props (e.g. an edited draft body). */
  props?: P;
}

export interface ActionDef<P, A> {
  /** States the action is allowed from. */
  from: readonly string[];
  payload: z.ZodType<A>;
  /** "user": the app may send it. "system": only the server (a sign-in finished, a task ended). */
  by: "user" | "system";
  /** The payload carries a secret: it is never stored, logged or echoed. */
  sensitive?: boolean;
  apply(view: BlockView<P>, payload: A): Transition<P>;
}

export interface BlockKind<P = Record<string, unknown>> {
  kind: string;
  /** Schema version of this kind; bump on a breaking change to props. */
  v: number;
  props: z.ZodType<P>;
  initial: string;
  states: readonly string[];
  /** States after which nothing more happens. */
  terminal: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions: Record<string, ActionDef<P, any>>;
  /** Plain text for notifications, the CLI, the digest and clients that don't know the kind. */
  fallbackText(view: BlockView<P>): string;
  /** Extra text for thread search. */
  searchText?(props: P): string;
}

export function defineKind<P>(kind: BlockKind<P>): BlockKind<P> {
  return kind;
}

export const empty = z.object({}).strict();

// ── shared pieces ────────────────────────────────────────────────────────────────────────────

const line = (max: number) => z.string().trim().min(1).max(max);
export const shortText = line(120);
export const sentence = line(300);

/** A label/value row ("Order · #4417 · Linen throw"), as in the details and known slots. */
export const KvRow = z.object({ label: line(40), value: line(160) });
export type KvRow = z.infer<typeof KvRow>;

/**
 * An app or service mark. `app` is an Executor app id or a well-known name (the client maps it to a
 * logo it has); `domain` lets the client show the site's logo. Never an arbitrary image URL.
 */
export const Mark = z
  .object({
    app: z.string().trim().min(1).max(60).optional(),
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, "a domain like resy.com")
      .optional(),
  })
  .strict();
export type Mark = z.infer<typeof Mark>;

/** Vault entry names: lowercase letters, digits, dots, dashes and underscores (`resy.login`). */
export const VaultName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "lowercase letters, digits, dots, dashes and underscores");

export function kvText(rows: readonly KvRow[] | undefined): string {
  return (rows ?? []).map((r) => `${r.label}: ${r.value}`).join("\n");
}
