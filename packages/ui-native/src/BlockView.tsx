import type {
  ActionProps,
  CardNode,
  CardProps,
  ChoicesProps,
  ConnectRequestProps,
  DraftProps,
  MemoryNoteProps,
  SecretRequestProps,
  ToolApprovalProps,
} from "@poke/blocks";
import type { Block } from "@poke/contracts";
import { Image } from "expo-image";
import { Fragment, type ReactNode, useState } from "react";
import { Switch, TextInput, View } from "react-native";
import { MemoryNote } from "./activity";
import { ActionCard, Choice, Choices, Draft, KvList, SecretRequest, useCardStyle } from "./blocks";
import { Logo } from "./marks";
import { Button, Chip } from "./primitives";
import { ConnectRequest, ToolApproval } from "./requests";
import { Text } from "./Text";
import { useTheme } from "./theme";

/** What a block renderer can ask the app to do. Every call maps to POST /v1/blocks/:id/actions. */
export interface BlockHandlers {
  /** Runs a block action. Resolves when the server accepted it; rejects with a readable message. */
  act(block: Block, action: string, payload?: Record<string, unknown>): Promise<void>;
  /** "Something else…": focus the composer (with the block as context). */
  writeOwn?(block: Block): void;
  copy?(text: string): void;
  /** Reads the clipboard for SecretRequest's Paste. */
  paste?(): Promise<string | undefined>;
  /** Opens a link (card text links) after his tap. */
  openLink?(url: string): void;
  /** Image proxy URL for a card image (the phone never fetches third-party images directly). */
  imageSource?(src: string): { uri: string; headers?: Record<string, string> };
}

/** Renders one block by kind; unknown kinds fall back to their plain text. */
export function BlockView({ block, handlers }: { block: Block; handlers: BlockHandlers }) {
  const props = block.props as Record<string, unknown>;
  const act = (action: string, payload?: Record<string, unknown>) => handlers.act(block, action, payload);
  switch (block.kind) {
    case "choices":
      return <ChoicesBlock block={block} props={props as unknown as ChoicesProps} handlers={handlers} />;
    case "draft":
      return <DraftBlock block={block} props={props as unknown as DraftProps} handlers={handlers} />;
    case "action":
      return <ActionBlock block={block} props={props as unknown as ActionProps} act={act} />;
    case "secret_request": {
      const p = props as unknown as SecretRequestProps;
      return (
        <SecretRequest
          state={block.state as "pending" | "saved" | "expired"}
          title={p.title}
          note={p.note}
          field={p.field}
          {...(p.placeholder ? { placeholder: p.placeholder } : {})}
          secretType={p.secretType}
          known={p.known ?? []}
          icon={<Logo mark={{ ...p.icon, name: p.service }} size={22} />}
          onSave={(value) => act("save", { value })}
          {...(handlers.paste ? { onPaste: handlers.paste } : {})}
        />
      );
    }
    case "connect_request": {
      const p = props as unknown as ConnectRequestProps;
      const lastError =
        typeof block.resolution?.lastError === "string" ? block.resolution.lastError : undefined;
      return (
        <ConnectRequest
          kind={p.kind}
          state={block.state as ConnectRequestState}
          title={p.title}
          note={p.note}
          {...(p.source ? { source: p.source } : {})}
          caps={p.caps ?? []}
          {...(lastError && block.state === "pending"
            ? { error: "The sign-in didn't finish. Try again." }
            : {})}
          icon={
            <Logo
              mark={{ ...p.icon, app: p.icon?.app ?? p.app, name: p.title.replace(/^Connect\s+/i, "") }}
              size={24}
            />
          }
          onConnect={() => void act("connect")}
          onDismiss={() => void act("dismiss")}
        />
      );
    }
    case "tool_approval": {
      const p = props as unknown as ToolApprovalProps;
      return (
        <ToolApproval
          state={block.state as "pending" | "allowed" | "denied" | "expired"}
          app={p.app}
          tool={p.tool}
          action={p.action}
          {...(p.reason ? { reason: p.reason } : {})}
          {...(p.always ? { always: p.always } : {})}
          {...(block.resolution?.always ? { result: "Always allowed" } : {})}
          details={p.details ?? []}
          icon={<Logo mark={{ ...p.icon, name: p.app }} size={26} radius={0} />}
          onAllow={(always) => void act("allow", always ? { always: true } : {})}
          onDeny={() => void act("deny")}
        />
      );
    }
    case "memory_note": {
      const p = props as unknown as MemoryNoteProps;
      if (block.state === "undone") {
        return (
          <Text size="footnote" color="ink3">
            Forgot: {p.text}
          </Text>
        );
      }
      return <MemoryNote text={p.text} onAction={() => void act("undo")} />;
    }
    case "card":
      return <CardBlock block={block} props={props as unknown as CardProps} handlers={handlers} />;
    default:
      return (
        <Text size="callout" color="ink2" selectable>
          {block.fallback ?? "This needs a newer version of the app."}
        </Text>
      );
  }
}

type ConnectRequestState = "pending" | "connecting" | "connected" | "dismissed" | "expired";

function ChoicesBlock({
  block,
  props,
  handlers,
}: {
  block: Block;
  props: ChoicesProps;
  handlers: BlockHandlers;
}) {
  const [busy, setBusy] = useState(false);
  if (block.state === "answered") return null; // His answer shows as his own message.
  const pick = async (index: number) => {
    setBusy(true);
    try {
      await handlers.act(block, "pick", { index });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Choices>
      {props.options.map((o, i) => (
        <Choice
          key={i}
          n={String(i + 1)}
          label={o.label}
          {...(o.hint ? { hint: o.hint } : {})}
          disabled={busy}
          onPress={() => void pick(i)}
        />
      ))}
      <Choice
        kind="write"
        label="Something else…"
        disabled={busy}
        onPress={() => handlers.writeOwn?.(block)}
      />
    </Choices>
  );
}

function DraftBlock({
  block,
  props,
  handlers,
}: {
  block: Block;
  props: DraftProps;
  handlers: BlockHandlers;
}) {
  const [state, setState] = useState<"idle" | "editing">("idle");
  const live = block.state === "idle" || block.state === "editing";
  const meta = [props.to ? `To ${props.to}` : undefined, props.subject].filter(Boolean).join(" · ");
  return (
    <Draft
      state={state}
      kind={props.kind}
      {...(meta ? { meta } : {})}
      body={props.body}
      readOnly={!live}
      onStateChange={setState}
      onEdit={(body) => void handlers.act(block, "edit", { body })}
      onCopy={() => handlers.copy?.(props.body)}
      actions={
        live && props.primary ? (
          <Button
            tone="ink"
            size="medium"
            label={props.primary.label}
            onPress={() => void handlers.act(block, "primary")}
          />
        ) : block.state === "sent" ? (
          <Text size="footnote" color="ink3">
            Done
          </Text>
        ) : undefined
      }
    />
  );
}

function ActionBlock({
  block,
  props,
  act,
}: {
  block: Block;
  props: ActionProps;
  act: (a: string, p?: Record<string, unknown>) => Promise<void>;
}) {
  const decided: Record<string, string> = {
    confirmed: "Confirmed",
    changed: "Asked for a change",
    cancelled: "Cancelled",
    expired: "Expired",
  };
  return (
    <ActionCard
      kind={props.kind}
      title={props.title}
      body={props.body}
      details={props.details?.length ? <KvList rows={props.details} /> : undefined}
      actions={
        block.state === "pending" ? (
          <>
            {props.change ? (
              <View style={{ flex: 1 }}>
                <Button
                  tone="fill"
                  size="medium"
                  width="fill"
                  label={props.change}
                  onPress={() => void act("change", {})}
                />
              </View>
            ) : null}
            <View style={{ flex: 1 }}>
              <Button
                tone="ink"
                size="medium"
                width="fill"
                label={props.confirm}
                onPress={() => void act("confirm")}
              />
            </View>
          </>
        ) : (
          <Text size="footnote" color="ink3">
            {decided[block.state] ?? block.state}
          </Text>
        )
      }
    />
  );
}

// ── card ───────────────────────────────────────────────────────────────────────────────────

function CardBlock({ block, props, handlers }: { block: Block; props: CardProps; handlers: BlockHandlers }) {
  const card = useCardStyle();
  const [values, setValues] = useState<Record<string, string | boolean>>(props.data ?? {});
  const active = block.state === "active";
  const pressed = Array.isArray(block.resolution?.pressed) ? (block.resolution.pressed as string[]) : [];
  const press = (actionId: string) => void handlers.act(block, "press", { actionId, values });
  const c = useTheme().colors;
  const render = (id: string, depth: number): ReactNode => {
    const node = props.nodes[id];
    if (!node || depth > 6) return null;
    return <Fragment key={id}>{renderNode(node, depth)}</Fragment>;
  };
  // A plain function, not a nested component: fields keep focus while values change.
  const renderNode = (node: CardNode, depth: number): ReactNode => {
    switch (node.type) {
      case "stack":
        return (
          <View style={{ gap: node.gap === "s" ? 6 : node.gap === "l" ? 16 : 10 }}>
            {node.children.map((k) => render(k, depth + 1))}
          </View>
        );
      case "row":
        return (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              justifyContent:
                node.align === "end"
                  ? "flex-end"
                  : node.align === "center"
                    ? "center"
                    : node.align === "between"
                      ? "space-between"
                      : "flex-start",
            }}
          >
            {node.children.map((k) => render(k, depth + 1))}
          </View>
        );
      case "heading":
        return (
          <Text
            family="display"
            size={node.level === 1 ? "title2" : node.level === 3 ? "callout" : "title3"}
            lineHeight={node.level === 1 ? 28 : 24}
          >
            {node.text}
          </Text>
        );
      case "text":
        return (
          <RichText
            text={node.text}
            size={node.size ?? "body"}
            muted={node.tone === "muted"}
            {...(handlers.openLink ? { onLink: handlers.openLink } : {})}
          />
        );
      case "kv":
        return <KvList rows={node.rows} />;
      case "list":
        return (
          <View style={{ gap: 4 }}>
            {node.items.map((item, i) => (
              <View key={i} style={{ flexDirection: "row", gap: 8 }}>
                <Text size="callout" color="ink3" style={{ minWidth: 14 }}>
                  {node.ordered ? `${i + 1}.` : "•"}
                </Text>
                <View style={{ flex: 1 }}>
                  <RichText
                    text={item}
                    size="callout"
                    {...(handlers.openLink ? { onLink: handlers.openLink } : {})}
                  />
                </View>
              </View>
            ))}
          </View>
        );
      case "chips":
        return (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {node.items.map((chip, i) => (
              <Chip
                key={i}
                label={chip.label}
                state={chip.actionId && pressed.includes(chip.actionId) ? "selected" : "default"}
                disabled={!active || !chip.actionId}
                onPress={() => chip.actionId && press(chip.actionId)}
              />
            ))}
          </View>
        );
      case "image":
        return handlers.imageSource ? (
          <Image
            source={handlers.imageSource(node.src)}
            accessibilityLabel={node.alt}
            style={{
              width: "100%",
              aspectRatio: node.aspect ?? 16 / 9,
              borderRadius: 14,
              backgroundColor: c.fill,
            }}
            contentFit="cover"
          />
        ) : null;
      case "divider":
        return <View style={{ height: 1, backgroundColor: c.separator }} />;
      case "field":
        return (
          <View style={{ gap: 4 }}>
            <Text size="caption" color="ink3">
              {node.label}
            </Text>
            <TextInput
              value={typeof values[node.key] === "string" ? (values[node.key] as string) : ""}
              onChangeText={(v) => setValues((old) => ({ ...old, [node.key]: v }))}
              {...(node.placeholder ? { placeholder: node.placeholder } : {})}
              placeholderTextColor={c.ink3}
              multiline={node.multiline ?? false}
              editable={active}
              accessibilityLabel={node.label}
              style={{
                minHeight: node.multiline ? 80 : 44,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: c.fill2,
                fontFamily: "OpenRunde-Regular",
                fontSize: 16,
                color: c.ink,
                textAlignVertical: "top",
              }}
            />
          </View>
        );
      case "toggle":
        return (
          <View
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}
          >
            <Text size="callout" style={{ flex: 1 }}>
              {node.label}
            </Text>
            <Switch
              value={values[node.key] === true}
              onValueChange={(v) => setValues((old) => ({ ...old, [node.key]: v }))}
              disabled={!active}
              trackColor={{ true: c.ink, false: c.fill2 }}
              accessibilityLabel={node.label}
            />
          </View>
        );
      case "button":
        return (
          <Button
            tone={node.tone ?? "ink"}
            size="medium"
            label={node.label}
            disabled={!active}
            onPress={() => press(node.actionId)}
          />
        );
      case "logo":
        return <Logo mark={node.mark} size={node.size === "s" ? 20 : node.size === "l" ? 44 : 30} />;
      default:
        return null;
    }
  };
  return <View style={[card, { padding: 16, borderRadius: 20, gap: 10 }]}>{render(props.root, 0)}</View>;
}

/** Plain text with **bold** and [label](https://link), the card's two inline marks. */
export function RichText({
  text,
  size = "body",
  muted,
  onLink,
}: {
  text: string;
  size?: "body" | "callout" | "footnote" | "caption";
  muted?: boolean;
  onLink?: (url: string) => void;
}) {
  const pieces = parseRich(text);
  return (
    <Text size={size} color={muted ? "ink2" : "ink"} lineHeight={size === "body" ? 24 : undefined} selectable>
      {pieces.map((p, i) =>
        p.kind === "bold" ? (
          <Text key={i} size={size} weight="semibold" color={muted ? "ink2" : "ink"}>
            {p.text}
          </Text>
        ) : p.kind === "link" ? (
          <Text key={i} size={size} color="link" onPress={() => onLink?.(p.url)} accessibilityRole="link">
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

export type RichPiece =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; url: string };

export function parseRich(text: string): RichPiece[] {
  const out: RichPiece[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ kind: "text", text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: "bold", text: m[1] });
    else out.push({ kind: "link", text: m[2]!, url: m[3]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: "text", text: text.slice(at) });
  return out;
}
