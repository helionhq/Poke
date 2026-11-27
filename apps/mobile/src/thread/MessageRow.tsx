import { clock, type Message, type OutboxEntry } from "@poke/client";
import {
  BlockView,
  type BlockHandlers,
  MessageActions,
  RichText,
  Text,
  UserMessage,
  useColors,
} from "@poke/ui-native";
import { Image } from "expo-image";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { usePoke, useThread } from "../lib/poke";
import { TraceRow } from "./TraceRow";

type AttachmentPart = Extract<Message["parts"][number], { type: "attachment" }>;

export interface RowCallbacks {
  onLongPress(message: Message, text: string): void;
  onSpeak?(message: Message, text: string): void;
  speakingId?: string;
  routineName(routineId: string): string | undefined;
  handlers: BlockHandlers;
}

/** One message as the thread draws it. Poke's replies are never bubbles. */
export const MessageRow = memo(function MessageRow({
  message,
  text,
  streaming,
  latest,
  highlighted,
  cb,
}: {
  message: Message;
  text: string;
  streaming: boolean;
  latest: boolean;
  highlighted: boolean;
  cb: RowCallbacks;
}) {
  const store = useThread();
  const c = useColors();
  if (message.role === "system") {
    return (
      <Text size="footnote" color="ink3" align="center" style={{ paddingHorizontal: 24 }} selectable>
        {text}
      </Text>
    );
  }
  const attachments = message.parts.filter((p): p is AttachmentPart => p.type === "attachment");
  if (message.role === "user") {
    const quote = message.replyTo ? <Quote excerpt={message.replyTo.excerpt} /> : null;
    return (
      <Pressable
        onLongPress={() => cb.onLongPress(message, text)}
        delayLongPress={350}
        style={highlighted ? { opacity: 0.85 } : null}
      >
        <UserMessage
          text={text}
          {...(attachments.length ? { attachment: <Attachments parts={attachments} /> } : {})}
          {...(quote ? { quote } : {})}
        />
      </Pressable>
    );
  }
  const origin = message.origin.kind === "routine" ? message.origin : undefined;
  return (
    <View
      style={[
        { gap: 12 },
        highlighted && { backgroundColor: c.fill, borderRadius: 16, marginHorizontal: -8, padding: 8 },
      ]}
    >
      {origin ? (
        <Text size="footnote" color="ink3">
          {cb.routineName(origin.routineId) ?? "Routine"}
          {origin.late ? " · ran late" : ""} · {clock(message.createdAt)}
        </Text>
      ) : null}
      {message.parts.map((part, i) => {
        switch (part.type) {
          case "trace":
            return <TraceRow key={`t${i}`} traceId={part.traceId} />;
          case "text": {
            // Streaming text arrives as deltas on the last text part.
            const isLast = message.parts.findLastIndex((p) => p.type === "text") === i;
            const shown = isLast && streaming ? store.text(message).slice(textBefore(message, i)) : part.text;
            if (!shown) return null;
            return (
              <Pressable key={`x${i}`} onLongPress={() => cb.onLongPress(message, text)} delayLongPress={350}>
                <RichText
                  text={shown}
                  size="body"
                  {...(cb.handlers.openLink ? { onLink: cb.handlers.openLink } : {})}
                />
              </Pressable>
            );
          }
          case "block": {
            const block = store.block(part.blockId);
            return block ? <BlockView key={part.blockId} block={block} handlers={cb.handlers} /> : null;
          }
          case "attachment":
            return null;
        }
      })}
      {attachments.length ? <Attachments parts={attachments} align="flex-start" /> : null}
      {latest && !streaming ? (
        <MessageActions
          meta={clock(message.createdAt)}
          onCopy={() => cb.handlers.copy?.(text)}
          onSpeak={() => cb.onSpeak?.(message, text)}
          speaking={cb.speakingId === message.id}
        />
      ) : null}
    </View>
  );
});

/** Length of the text parts joined before index i (so a streaming part shows only its own text). */
function textBefore(message: Message, index: number): number {
  let n = 0;
  let first = true;
  message.parts.forEach((p, i) => {
    if (i >= index || p.type !== "text") return;
    n += (first ? 0 : 2) + p.text.length;
    first = false;
  });
  return first ? 0 : n + 2;
}

function Quote({ excerpt }: { excerpt: string }) {
  const c = useColors();
  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: c.separator,
        paddingLeft: 10,
        marginBottom: 2,
        maxWidth: "100%",
      }}
    >
      <Text size="footnote" color="ink3" numberOfLines={2}>
        {excerpt}
      </Text>
    </View>
  );
}

function Attachments({
  parts,
  align = "flex-end",
}: {
  parts: AttachmentPart[];
  align?: "flex-start" | "flex-end";
}) {
  const { client } = usePoke();
  const c = useColors();
  const headers = client.authHeaders();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: align }}>
      {parts.map((p) =>
        p.kind === "image" || p.kind === "scan" ? (
          <Image
            key={p.attachmentId}
            source={{ uri: client.attachmentUrl(p.attachmentId), headers }}
            accessibilityLabel={p.name}
            style={{
              width: parts.length === 1 ? 220 : 120,
              aspectRatio: p.width && p.height ? Math.max(0.5, Math.min(2, p.width / p.height)) : 1,
              borderRadius: 18,
              backgroundColor: c.fill,
            }}
            contentFit="cover"
          />
        ) : (
          <View
            key={p.attachmentId}
            style={{
              paddingVertical: 10,
              paddingHorizontal: 14,
              borderRadius: 16,
              backgroundColor: c.card,
              borderWidth: 1,
              borderColor: c.separator,
            }}
          >
            <Text size="subhead" weight="medium" numberOfLines={1}>
              {p.name}
            </Text>
          </View>
        ),
      )}
    </View>
  );
}

/** A message still in the outbox: his bubble, quieter, with "Sending…" or a retry. */
export function PendingRow({
  entry,
  onRetry,
  onDiscard,
}: {
  entry: OutboxEntry;
  onRetry(): void;
  onDiscard(): void;
}) {
  return (
    <View style={{ alignItems: "flex-end", gap: 4, opacity: entry.state === "failed" ? 1 : 0.7 }}>
      <UserMessage text={entry.text || (entry.attachmentIds.length ? "Attachment" : "")} />
      {entry.state === "failed" ? (
        <View style={{ flexDirection: "row", gap: 14 }}>
          <Text size="caption" color="red">
            {entry.error ?? "Not sent"}
          </Text>
          <Text size="caption" weight="semibold" onPress={onRetry} accessibilityRole="button">
            Retry
          </Text>
          <Text size="caption" color="ink3" onPress={onDiscard} accessibilityRole="button">
            Delete
          </Text>
        </View>
      ) : (
        <Text size="caption" color="ink3">
          {entry.state === "sending" ? "Sending…" : "Waiting for Poke"}
        </Text>
      )}
    </View>
  );
}
