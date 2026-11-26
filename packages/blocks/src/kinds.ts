import { z } from "zod";
import { defineKind, empty, KvRow, kvText, Mark, sentence, shortText, VaultName } from "./kind.js";

// Props mirror the Doop "Poke One" components (prop and slot names, states). Text a component
// shows by default ("Something else…", "Save", "Not now") is the client's, not the agent's.

// ── choices: Choices + Choice ────────────────────────────────────────────────────────────────

export const ChoicesProps = z
  .object({
    options: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(80), hint: z.string().trim().max(120).optional() })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type ChoicesProps = z.infer<typeof ChoicesProps>;

export const choices = defineKind<ChoicesProps>({
  kind: "choices",
  v: 1,
  props: ChoicesProps,
  initial: "pending",
  states: ["pending", "answered"],
  terminal: ["answered"],
  actions: {
    /** Tapping an option: its label is sent as the user's message. */
    pick: {
      from: ["pending"],
      by: "user",
      payload: z.object({ index: z.number().int().min(0).max(2) }).strict(),
      apply: ({ props }, { index }) => {
        const option = props.options[index];
        if (!option) throw new BlockActionError("That option doesn't exist");
        return { state: "answered", resolution: { answer: option.label, index } };
      },
    },
    /** "Something else…": the user's own words, also sent as their message. */
    write: {
      from: ["pending"],
      by: "user",
      payload: z.object({ text: z.string().trim().min(1).max(4000) }).strict(),
      apply: (_view, { text }) => ({ state: "answered", resolution: { answer: text } }),
    },
  },
  fallbackText: ({ props, state, resolution }) =>
    state === "answered"
      ? `Answered: ${String(resolution?.answer ?? "")}`
      : props.options.map((o, i) => `${i + 1}. ${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("\n"),
  searchText: (props) => props.options.map((o) => o.label).join(" "),
});

// ── draft: Draft ─────────────────────────────────────────────────────────────────────────────

export const DraftProps = z
  .object({
    /** The kind label: "Email", "Text to Maya", "LinkedIn post". */
    kind: z.string().trim().min(1).max(40),
    /** Meta line pieces; the client shows them as "To · Subject". */
    to: z.string().trim().max(200).optional(),
    subject: z.string().trim().max(200).optional(),
    body: z.string().min(1).max(20_000),
    /** The optional primary action ("Send from Gmail", "Open in Gmail"). Copy is always there. */
    primary: z
      .object({ label: z.string().trim().min(1).max(40) })
      .strict()
      .optional(),
  })
  .strict();
export type DraftProps = z.infer<typeof DraftProps>;

export const draft = defineKind<DraftProps>({
  kind: "draft",
  v: 1,
  props: DraftProps,
  initial: "idle",
  // "editing" is local to the app while the caret is in the body; the server only stores idle/sent.
  // "expired": a send waiting for an OK whose agent stopped waiting.
  states: ["idle", "editing", "sent", "expired"],
  terminal: ["sent", "expired"],
  actions: {
    edit: {
      from: ["idle", "editing"],
      by: "user",
      payload: z
        .object({
          body: z.string().min(1).max(20_000),
          subject: z.string().trim().max(200).optional(),
          to: z.string().trim().max(200).optional(),
        })
        .strict(),
      apply: ({ props }, edit) => ({
        state: "idle",
        props: {
          ...props,
          body: edit.body,
          ...(edit.subject !== undefined ? { subject: edit.subject } : {}),
          ...(edit.to !== undefined ? { to: edit.to } : {}),
        },
        resolution: { edited: true },
      }),
    },
    primary: {
      from: ["idle", "editing"],
      by: "user",
      payload: empty,
      apply: ({ props, resolution }) => {
        if (!props.primary) throw new BlockActionError("This draft has no action to run");
        return {
          state: "sent",
          resolution: {
            action: "primary",
            label: props.primary.label,
            ...(resolution?.edited ? { edited: true } : {}),
          },
        };
      },
    },
    expire: { from: ["idle", "editing"], by: "system", payload: empty, apply: () => ({ state: "expired" }) },
  },
  fallbackText: ({ props, state }) =>
    [
      `${props.kind}${props.to ? ` to ${props.to}` : ""}${props.subject ? `: ${props.subject}` : ""}${state === "sent" ? " (sent on)" : ""}`,
      props.body,
    ].join("\n"),
  searchText: (props) => [props.subject, props.to, props.body].filter(Boolean).join(" "),
});

// ── action: ActionCard ───────────────────────────────────────────────────────────────────────

export const ActionProps = z
  .object({
    /** The small label: "Book a table", "Buy", "Hold". */
    kind: z.string().trim().min(1).max(40),
    title: shortText,
    body: z.string().trim().min(1).max(200),
    details: z.array(KvRow).max(8).optional(),
    /** Button labels, e.g. Book / Change. */
    confirm: z.string().trim().min(1).max(30),
    change: z.string().trim().min(1).max(30).optional(),
  })
  .strict();
export type ActionProps = z.infer<typeof ActionProps>;

export const action = defineKind<ActionProps>({
  kind: "action",
  v: 1,
  props: ActionProps,
  initial: "pending",
  states: ["pending", "confirmed", "changed", "cancelled", "expired"],
  terminal: ["confirmed", "changed", "cancelled", "expired"],
  actions: {
    confirm: {
      from: ["pending"],
      by: "user",
      payload: empty,
      apply: () => ({ state: "confirmed", resolution: { decision: "confirmed" } }),
    },
    change: {
      from: ["pending"],
      by: "user",
      payload: z.object({ note: z.string().trim().max(1000).optional() }).strict(),
      apply: (_v, { note }) => ({
        state: "changed",
        resolution: { decision: "changed", ...(note ? { note } : {}) },
      }),
    },
    cancel: {
      from: ["pending"],
      by: "user",
      payload: empty,
      apply: () => ({ state: "cancelled", resolution: { decision: "cancelled" } }),
    },
    expire: { from: ["pending"], by: "system", payload: empty, apply: () => ({ state: "expired" }) },
  },
  fallbackText: ({ props, state }) =>
    [
      `${props.kind}: ${props.title}`,
      props.body,
      kvText(props.details),
      state === "pending" ? "" : `(${state})`,
    ]
      .filter(Boolean)
      .join("\n"),
  searchText: (props) => [props.kind, props.title, props.body, kvText(props.details)].join(" "),
});

// ── secret_request: SecretRequest ────────────────────────────────────────────────────────────

export const SecretType = z.enum(["password", "api_key", "code", "card", "text"]);
export type SecretType = z.infer<typeof SecretType>;

export const SecretRequestProps = z
  .object({
    service: shortText,
    icon: Mark.optional(),
    /** "Resy login", "OpenWeather API key", "Verification code". */
    title: shortText,
    /** Why Poke needs it. */
    note: sentence,
    /** Label of the one thing to fill in: "Password", "API key", "Code". */
    field: z.string().trim().min(1).max(40),
    placeholder: z.string().trim().max(80).optional(),
    secretType: SecretType,
    /** The vault entry it is saved as; the secret field is named after `secretType`. */
    vaultName: VaultName,
    /** One-time codes: used once and wiped (vault `ephemeral`). */
    ephemeral: z.boolean().optional(),
    /** What Poke already knows (service, email, phone): the `known` slot. Empty for an API key. */
    known: z.array(KvRow).max(6).optional(),
    /** Non-secret fields saved with the vault entry (email, username), by key. Not shown. */
    fields: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(200)).optional(),
  })
  .strict();
export type SecretRequestProps = z.infer<typeof SecretRequestProps>;

export const secretRequest = defineKind<SecretRequestProps>({
  kind: "secret_request",
  v: 1,
  props: SecretRequestProps,
  initial: "pending",
  // "filled" is local to the app while typing; the value never reaches a block or a message.
  states: ["pending", "filled", "saved", "expired"],
  terminal: ["saved", "expired"],
  actions: {
    save: {
      from: ["pending", "filled"],
      by: "user",
      sensitive: true,
      payload: z.object({ value: z.string().min(1).max(8192) }).strict(),
      apply: ({ props }) => ({ state: "saved", resolution: { status: "saved", vaultName: props.vaultName } }),
    },
    expire: {
      from: ["pending", "filled"],
      by: "system",
      payload: empty,
      apply: () => ({ state: "expired" }),
    },
  },
  fallbackText: ({ props, state }) =>
    state === "saved"
      ? `${props.title} ✓ Saved to your Vault`
      : state === "expired"
        ? `${props.title}: no longer needed`
        : `Poke needs your ${props.service} ${props.field.toLowerCase()}. Add it in the Poke app.`,
  searchText: (props) => `${props.service} ${props.title}`,
});

// ── connect_request: ConnectRequest ──────────────────────────────────────────────────────────

export const ConnectRequestProps = z
  .object({
    kind: z.enum(["app", "custom"]),
    /** Executor app id (or the custom integration's id). */
    app: z.string().trim().min(1).max(80),
    icon: Mark.optional(),
    /** "Connect Notion". */
    title: shortText,
    /** Why Poke needs it. */
    note: sentence,
    /** custom only: "Set up by Poke from the Strava API · 9 tools". */
    source: z.string().trim().max(160).optional(),
    /** What Poke will be able to do: the `caps` slot. */
    caps: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
  })
  .strict();
export type ConnectRequestProps = z.infer<typeof ConnectRequestProps>;

export const connectRequest = defineKind<ConnectRequestProps>({
  kind: "connect_request",
  v: 1,
  props: ConnectRequestProps,
  initial: "pending",
  states: ["pending", "connecting", "connected", "dismissed", "expired"],
  terminal: ["connected", "dismissed", "expired"],
  actions: {
    /** Connect: the server starts the sign-in and answers with the URL the app opens. */
    connect: {
      from: ["pending", "connecting"],
      by: "user",
      payload: empty,
      apply: () => ({ state: "connecting" }),
    },
    dismiss: {
      from: ["pending", "connecting"],
      by: "user",
      payload: empty,
      apply: () => ({ state: "dismissed", resolution: { status: "dismissed" } }),
    },
    connected: {
      from: ["pending", "connecting"],
      by: "system",
      payload: z
        .object({ connectionId: z.string().max(120).optional(), account: z.string().max(200).optional() })
        .strict(),
      apply: (_v, p) => ({ state: "connected", resolution: { status: "connected", ...p } }),
    },
    /** The sign-in didn't finish: back to pending so it can be tried again. */
    failed: {
      from: ["connecting"],
      by: "system",
      payload: z.object({ error: z.string().max(300) }).strict(),
      apply: (_v, { error }) => ({ state: "pending", resolution: { lastError: error } }),
    },
    expire: {
      from: ["pending", "connecting"],
      by: "system",
      payload: empty,
      apply: () => ({ state: "expired" }),
    },
  },
  fallbackText: ({ props, state }) =>
    state === "connected"
      ? `${props.title.replace(/^Connect\s+/i, "")} ✓ Connected`
      : state === "dismissed" || state === "expired"
        ? `${props.title}: not connected`
        : `${props.title}: ${props.note} Connect it in the Poke app.`,
  searchText: (props) => `${props.title} ${props.app}`,
});

// ── tool_approval: ToolApproval ──────────────────────────────────────────────────────────────

export const ToolApprovalProps = z
  .object({
    /** App name, as shown: "Gmail". */
    app: shortText,
    icon: Mark.optional(),
    /** The tool's own name, shown in mono: "send_email". */
    tool: z.string().trim().min(1).max(120),
    /** What will happen, in plain words: "Refund $84.00 to Maya Chen". */
    action: z.string().trim().min(1).max(200),
    details: z.array(KvRow).max(10).optional(),
    /** Why it needs an OK: "Refunds can't be undone." */
    reason: z.string().trim().max(200).optional(),
    /** The optional standing permission: "Always allow refunds under $100". */
    always: z.string().trim().max(120).optional(),
  })
  .strict();
export type ToolApprovalProps = z.infer<typeof ToolApprovalProps>;

export const toolApproval = defineKind<ToolApprovalProps>({
  kind: "tool_approval",
  v: 1,
  props: ToolApprovalProps,
  initial: "pending",
  states: ["pending", "allowed", "denied", "expired"],
  terminal: ["allowed", "denied", "expired"],
  actions: {
    allow: {
      from: ["pending"],
      by: "user",
      payload: z.object({ always: z.boolean().optional() }).strict(),
      apply: ({ props }, { always }) => ({
        state: "allowed",
        resolution: { decision: "allowed", ...(always && props.always ? { always: true } : {}) },
      }),
    },
    deny: {
      from: ["pending"],
      by: "user",
      payload: empty,
      apply: () => ({ state: "denied", resolution: { decision: "denied" } }),
    },
    expire: { from: ["pending"], by: "system", payload: empty, apply: () => ({ state: "expired" }) },
  },
  fallbackText: ({ props, state }) =>
    state === "pending"
      ? [
          `${props.app} ${props.tool} needs your OK: ${props.action}`,
          kvText(props.details),
          props.reason ?? "",
        ]
          .filter(Boolean)
          .join("\n")
      : `${props.app} ${props.tool} ${state === "allowed" ? "✓ Allowed" : state === "denied" ? "✗ Denied" : "· expired"}`,
  searchText: (props) => `${props.app} ${props.tool} ${props.action}`,
});

// ── memory_note: MemoryNote ──────────────────────────────────────────────────────────────────

export const MemoryNoteProps = z.object({ text: z.string().trim().min(1).max(300) }).strict();
export type MemoryNoteProps = z.infer<typeof MemoryNoteProps>;

export const memoryNote = defineKind<MemoryNoteProps>({
  kind: "memory_note",
  v: 1,
  props: MemoryNoteProps,
  initial: "saved",
  states: ["saved", "undone"],
  terminal: ["undone"],
  actions: {
    undo: {
      from: ["saved"],
      by: "user",
      payload: empty,
      apply: () => ({ state: "undone", resolution: { undone: true } }),
    },
  },
  fallbackText: ({ props, state }) =>
    state === "undone" ? `Forgot: ${props.text}` : `Remembered: ${props.text}`,
  searchText: (props) => props.text,
});

export class BlockActionError extends Error {}
