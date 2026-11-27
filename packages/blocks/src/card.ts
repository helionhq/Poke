import { z } from "zod";
import { defineKind, Mark } from "./kind.js";
import { BlockActionError } from "./kinds.js";

/**
 * The catch-all `card`: a flat adjacency list of safe primitives (`nodes` by id, `root` names the
 * top one) plus a small data model for fields and toggles. No code, no styles, no URLs opened
 * without a tap. Inspired by A2UI / json-render, kept small.
 *
 * Text is plain, with two inline marks: **bold** and [label](https://link). Images are https URLs
 * the server will fetch on the app's behalf (an image proxy, milestone 9); the phone never
 * contacts them directly.
 */

export const CARD_LIMITS = {
  nodes: 60,
  depth: 6,
  buttons: 8,
  fields: 8,
  json: 16_000,
  children: 20,
} as const;

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/, "ids are short words: letters, digits, - and _");
const key = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,31}$/, "keys are short camelCase words");
const rich = z.string().trim().min(1).max(1000);
const children = z.array(id).min(1).max(CARD_LIMITS.children);
const https = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https:\/\/[a-z0-9.-]+(:\d{2,5})?(\/[^\s]*)?$/i, "an https URL");

export const CardNode = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stack"), children, gap: z.enum(["s", "m", "l"]).optional() }).strict(),
  z
    .object({
      type: z.literal("row"),
      children,
      align: z.enum(["start", "center", "end", "between"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("heading"),
      text: z.string().trim().min(1).max(120),
      level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      text: rich,
      tone: z.enum(["default", "muted"]).optional(),
      size: z.enum(["body", "footnote", "caption"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("kv"),
      rows: z
        .array(
          z
            .object({ label: z.string().trim().min(1).max(40), value: z.string().trim().min(1).max(200) })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  z
    .object({ type: z.literal("list"), items: z.array(rich).min(1).max(12), ordered: z.boolean().optional() })
    .strict(),
  z
    .object({
      type: z.literal("chips"),
      items: z
        .array(z.object({ label: z.string().trim().min(1).max(40), actionId: id.optional() }).strict())
        .min(1)
        .max(8),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      src: https,
      alt: z.string().trim().min(1).max(200),
      aspect: z.number().min(0.25).max(4).optional(),
    })
    .strict(),
  z.object({ type: z.literal("divider") }).strict(),
  z
    .object({
      type: z.literal("field"),
      key,
      label: z.string().trim().min(1).max(60),
      placeholder: z.string().trim().max(80).optional(),
      multiline: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("toggle"), key, label: z.string().trim().min(1).max(80) }).strict(),
  z
    .object({
      type: z.literal("button"),
      label: z.string().trim().min(1).max(30),
      actionId: id,
      tone: z.enum(["ink", "fill", "plain", "danger"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("logo"), mark: Mark, size: z.enum(["s", "m", "l"]).optional() }).strict(),
]);
export type CardNode = z.infer<typeof CardNode>;

export const CardProps = z
  .object({
    /** Short title for notifications and clients that can't draw the card. */
    title: z.string().trim().min(1).max(120),
    root: id,
    nodes: z.record(id, CardNode),
    /** Initial values for fields (strings) and toggles (booleans), by key. */
    data: z.record(key, z.union([z.string().max(2000), z.boolean()])).optional(),
  })
  .strict()
  .superRefine((card, ctx) => {
    for (const problem of cardProblems(card)) ctx.addIssue({ code: "custom", message: problem });
  });
export type CardProps = z.infer<typeof CardProps>;

/** Structural checks zod can't express: references, cycles, depth, size, unique keys. */
export function cardProblems(card: {
  root: string;
  nodes: Record<string, CardNode>;
  data?: Record<string, unknown>;
}): string[] {
  const problems: string[] = [];
  const ids = Object.keys(card.nodes);
  if (ids.length > CARD_LIMITS.nodes) problems.push(`A card has at most ${CARD_LIMITS.nodes} nodes`);
  if (JSON.stringify(card).length > CARD_LIMITS.json) problems.push("The card is too large; keep it short");
  if (!card.nodes[card.root]) {
    problems.push(`root "${card.root}" isn't a node`);
    return problems;
  }
  const seen = new Set<string>();
  const walk = (nodeId: string, depth: number, path: Set<string>) => {
    if (path.has(nodeId)) {
      problems.push(`"${nodeId}" contains itself`);
      return;
    }
    const node = card.nodes[nodeId];
    if (!node) {
      problems.push(`"${nodeId}" is referenced but not defined`);
      return;
    }
    if (seen.has(nodeId)) {
      problems.push(`"${nodeId}" is used twice; give each place its own node`);
      return;
    }
    seen.add(nodeId);
    if (depth > CARD_LIMITS.depth) {
      problems.push(`The card nests deeper than ${CARD_LIMITS.depth} levels`);
      return;
    }
    if (node.type === "stack" || node.type === "row") {
      const next = new Set(path).add(nodeId);
      for (const child of node.children) walk(child, depth + 1, next);
    }
  };
  walk(card.root, 1, new Set());
  for (const nodeId of ids)
    if (!seen.has(nodeId) && problems.length < 20) problems.push(`"${nodeId}" isn't reachable from the root`);

  const nodes = Object.values(card.nodes);
  const actionIds = actionIdsOf(card.nodes);
  const buttons =
    nodes.filter((n) => n.type === "button").length +
    nodes
      .filter((n) => n.type === "chips")
      .reduce((sum, n) => sum + (n.type === "chips" ? n.items.filter((i) => i.actionId).length : 0), 0);
  if (buttons > CARD_LIMITS.buttons) problems.push(`A card has at most ${CARD_LIMITS.buttons} buttons`);
  if (new Set(actionIds).size !== actionIds.length) problems.push("Each button needs its own actionId");
  const keys = inputKeysOf(card.nodes);
  if (keys.length > CARD_LIMITS.fields)
    problems.push(`A card has at most ${CARD_LIMITS.fields} fields and toggles`);
  if (new Set(keys).size !== keys.length) problems.push("Each field and toggle needs its own key");
  for (const dataKey of Object.keys(card.data ?? {}))
    if (!keys.includes(dataKey)) problems.push(`data.${dataKey} has no field or toggle`);
  if (actionIds.length === 0 && keys.length > 0)
    problems.push("Fields and toggles need a button to send them");
  return problems;
}

export function actionIdsOf(nodes: Record<string, CardNode>): string[] {
  const out: string[] = [];
  for (const node of Object.values(nodes)) {
    if (node.type === "button") out.push(node.actionId);
    if (node.type === "chips") for (const item of node.items) if (item.actionId) out.push(item.actionId);
  }
  return out;
}

function inputKeysOf(nodes: Record<string, CardNode>): string[] {
  return Object.values(nodes).flatMap((n) => (n.type === "field" || n.type === "toggle" ? [n.key] : []));
}

/** Plain text of a rich string: **bold** loses its stars, [label](url) becomes "label (url)". */
export function plainText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, "$1 ($2)");
}

function cardText(card: CardProps): string {
  const lines: string[] = [card.title];
  const visit = (nodeId: string) => {
    const node = card.nodes[nodeId];
    if (!node) return;
    switch (node.type) {
      case "stack":
      case "row":
        node.children.forEach(visit);
        return;
      case "heading":
        lines.push(node.text);
        return;
      case "text":
        lines.push(plainText(node.text));
        return;
      case "kv":
        for (const row of node.rows) lines.push(`${row.label}: ${row.value}`);
        return;
      case "list":
        node.items.forEach((item, i) => lines.push(`${node.ordered ? `${i + 1}.` : "-"} ${plainText(item)}`));
        return;
      case "chips":
        lines.push(node.items.map((i) => i.label).join(" · "));
        return;
      case "image":
        lines.push(`[image: ${node.alt}]`);
        return;
      default:
        return;
    }
  };
  visit(card.root);
  return lines.filter((l, i) => i === 0 || l !== lines[0]).join("\n");
}

export const card = defineKind<CardProps>({
  kind: "card",
  v: 1,
  props: CardProps as z.ZodType<CardProps>,
  initial: "active",
  states: ["active", "closed"],
  terminal: ["closed"],
  actions: {
    /** A button or chip: the actionId and the current field/toggle values go to the agent. */
    press: {
      from: ["active"],
      by: "user",
      payload: z
        .object({
          actionId: id,
          values: z.record(key, z.union([z.string().max(2000), z.boolean()])).optional(),
        })
        .strict(),
      apply: ({ props, resolution }, { actionId, values }) => {
        if (!actionIdsOf(props.nodes).includes(actionId))
          throw new BlockActionError("That button isn't on this card");
        const keys = inputKeysOf(props.nodes);
        const clean = Object.fromEntries(Object.entries(values ?? {}).filter(([k]) => keys.includes(k)));
        const pressed = Array.isArray(resolution?.pressed) ? (resolution.pressed as string[]) : [];
        return {
          state: "active",
          resolution: {
            pressed: [...pressed.filter((p) => p !== actionId), actionId],
            last: { actionId, values: clean },
          },
        };
      },
    },
    close: {
      from: ["active"],
      by: "system",
      payload: z.object({}).strict(),
      apply: () => ({ state: "closed" }),
    },
  },
  fallbackText: ({ props }) => cardText(props),
  searchText: (props) => cardText(props),
});
