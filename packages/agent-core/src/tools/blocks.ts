import {
  ActionProps,
  CardProps,
  ChoicesProps,
  DraftProps,
  KvRow,
  Mark,
  SecretType,
  VaultName,
} from "@poke/blocks";
import { z } from "zod";
import { defineToolSpec } from "./define.js";

/**
 * Poke's block tools (section 9). Each shows one interactive block under Poke's reply; the app
 * renders it from the catalog in @poke/blocks. What Arham does with it comes back as his next
 * message (choices) or as a <block_action> input (everything else).
 *
 * Executors never call these: their secret, connection and approval needs become blocks on the
 * server (section 9.4).
 */

export const askChoices = defineToolSpec({
  name: "ask_choices",
  description:
    "Offer up to 3 quick answers under your reply; the app adds a 'Something else…' row. Write the question itself as your reply text, right above. The answer comes back as Arham's next message. Use it when a few likely answers exist; otherwise just ask.",
  input: ChoicesProps,
  callers: ["model"],
  replay: "unsafe",
});

export const showDraft = defineToolSpec({
  name: "show_draft",
  description:
    "Show writing Arham will send on (an email, a text, a post) as an editable draft with a Copy button. `primary` adds one action button, e.g. 'Send from Gmail'; if he taps it you get a <block_action> with the final text. His edits are saved and you see the final text.",
  input: DraftProps,
  callers: ["model"],
  replay: "unsafe",
});

export const proposeAction = defineToolSpec({
  name: "propose_action",
  description:
    "Ask for an OK before doing something in the world (book, buy, hold, send): a small label (kind), a title, one line of detail, optional detail rows, and two buttons (confirm, and optionally change). You get a <block_action> with confirmed, changed (with his note) or cancelled. Don't act before it says confirmed.",
  input: ActionProps,
  callers: ["model"],
  replay: "unsafe",
});

export const showCard = defineToolSpec({
  name: "show_card",
  description: [
    "Show a rich result no other block fits, built from safe parts: three restaurants with a photo, rating and a Hold button each; an order summary as label/value rows; a package's status; a quick comparison. Use it only when the information has real structure; plain text is usually better.",
    "Shape: {title, root, nodes, data?}. `nodes` maps short ids to parts; `root` is the top one; stack/row list their children's ids (each node used once, at most 6 levels, 60 nodes).",
    "Parts: stack, row, heading, text (supports **bold** and [label](https://link)), kv (label/value rows), list, chips, image (https only), divider, logo ({mark:{domain}}), field and toggle (inputs, by key; initial values in data), button ({label, actionId}).",
    "A button press sends you a <block_action> with its actionId and the current field values.",
  ].join("\n"),
  input: CardProps,
  callers: ["model"],
  replay: "unsafe",
});

export const requestSecret = defineToolSpec({
  name: "request_secret",
  description:
    "Ask Arham for a secret you need yourself (password, API key, one-time code). He types it straight into his vault; you never see it, and you get a <block_action> with the vault name once it's saved. Prefill what you know in `known` (service, email, phone). Agents' secret needs are shown for you; don't call this for those.",
  input: z
    .object({
      service: z.string().trim().min(1).max(120),
      title: z.string().trim().min(1).max(120).describe('e.g. "Resy login", "OpenWeather API key"'),
      note: z.string().trim().min(1).max(300).describe("Why you need it"),
      field: z.string().trim().min(1).max(40).describe('Label of what he fills in, e.g. "Password"'),
      secretType: SecretType,
      vaultName: VaultName.describe('Where it is saved, e.g. "resy.login"'),
      known: z.array(KvRow).max(6).optional(),
      placeholder: z.string().trim().max(80).optional(),
      icon: Mark.optional(),
    })
    .strict(),
  callers: ["model"],
  replay: "unsafe",
});

export const requestConnection = defineToolSpec({
  name: "request_connection",
  description:
    "Ask Arham to connect an app you need, with one tap in the thread. You get a <block_action> when it's connected or he says not now. Agents' connection needs are shown for you; don't call this for those.",
  input: z
    .object({
      app: z.string().trim().min(1).max(80).describe("The app id"),
      appName: z.string().trim().min(1).max(80).describe('e.g. "Notion"'),
      note: z.string().trim().min(1).max(300).describe("Why you need it"),
      caps: z
        .array(z.string().trim().min(1).max(120))
        .max(6)
        .optional()
        .describe("What you'll be able to do"),
      icon: Mark.optional(),
    })
    .strict(),
  callers: ["model"],
  replay: "unsafe",
});

export const BLOCK_TOOLS = {
  askChoices,
  showDraft,
  proposeAction,
  showCard,
  requestSecret,
  requestConnection,
} as const;
