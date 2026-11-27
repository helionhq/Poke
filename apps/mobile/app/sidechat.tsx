import { type Block, type Message, type SideChatView, type Step, type Trace } from "@poke/client";
import {
  BlockView,
  Button,
  Composer,
  Icon,
  IconButton,
  RichText,
  Shimmer,
  Text,
  UserMessage,
  useColors,
} from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { blockHandlers } from "../src/lib/handlers";
import { usePoke } from "../src/lib/poke";
import { TraceView } from "../src/thread/TraceRow";

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
const blockIds = (m: Message) => m.parts.flatMap((p) => (p.type === "block" ? [p.blockId] : []));

type Traced = { trace: Trace; steps: Step[] };
type Row =
  | { key: string; kind: "user"; text: string }
  | { key: string; kind: "poke"; text: string; blocks: string[] }
  | { key: string; kind: "system"; text: string }
  | { key: string; kind: "trace"; traced: Traced };

/**
 * 09 Side chat: a quick question on the side that doesn't touch the main thread. It lives only
 * while open; "Send to Poke" hands the answer to the thread.
 */
export default function SideChatScreen() {
  const poke = usePoke();
  const { client, onEvent } = poke;
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [chat, setChat] = useState<SideChatView>();
  const [error, setError] = useState<string>();
  const [text, setText] = useState("");
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<"idle" | "thinking" | "working">("idle");
  const [sending, setSending] = useState(false);
  const [blocks, setBlocks] = useState<Record<string, Block>>({});
  const [traces, setTraces] = useState<Traced[]>([]);
  const id = useRef<string>(undefined);

  useEffect(() => {
    let alive = true;
    client.openSideChat().then(
      ({ sideChat }) => {
        id.current = sideChat.id;
        if (alive) {
          setChat(sideChat);
          setTraces(sideChat.traces ?? []);
        } else void client.closeSideChat(sideChat.id).catch(() => {});
      },
      (e: unknown) => alive && setError(e instanceof Error ? e.message : "Couldn't open a side chat"),
    );
    const off = onEvent((event) => {
      const scope = `sidechat:${id.current}`;
      if (event.type === "sidechat.message" && event.sideChatId === id.current) {
        setChat((old) =>
          old
            ? { ...old, messages: [...old.messages.filter((m) => m.id !== event.message.id), event.message] }
            : old,
        );
        // A card shown mid-reply sends the reply early: its text keeps streaming.
        if (event.message.status !== "streaming")
          setDeltas((d) => {
            const { [event.message.id]: _, ...rest } = d;
            return rest;
          });
      } else if (event.type === "sidechat.trace" && event.sideChatId === id.current) {
        const next = { trace: event.trace, steps: event.steps };
        setTraces((old) =>
          old.some((t) => t.trace.id === next.trace.id)
            ? old.map((t) => (t.trace.id === next.trace.id ? next : t))
            : [...old, next],
        );
      } else if (
        (event.type === "block.created" || event.type === "block.updated") &&
        event.block.scope === scope
      ) {
        setBlocks((old) => ({ ...old, [event.block.id]: event.block }));
      } else if (event.type === "message.delta" && event.scope === scope) {
        setDeltas((d) => ({ ...d, [event.messageId]: (d[event.messageId] ?? "") + event.text }));
      } else if (event.type === "agent.activity" && event.scope === scope) {
        setActivity(event.activity);
      }
    });
    return () => {
      alive = false;
      off();
      // Side chats vanish when closed.
      if (id.current) void client.closeSideChat(id.current).catch(() => {});
    };
  }, [client, onEvent]);

  const send = async () => {
    const body = text.trim();
    if (!body || !chat) return;
    setText("");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const { message } = await client.sendSideChat(chat.id, body);
      setChat((old) =>
        old ? { ...old, messages: [...old.messages.filter((m) => m.id !== message.id), message] } : old,
      );
    } catch (e) {
      setText(body);
      Alert.alert("Not sent", e instanceof Error ? e.message : "");
    }
  };

  const handlers = useMemo(
    () => blockHandlers(poke, { onBlock: (block) => setBlocks((old) => ({ ...old, [block.id]: block })) }),
    [poke],
  );

  const sendToPoke = async () => {
    if (!chat) return;
    setSending(true);
    try {
      await client.sendSideChatToPoke(chat.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (e) {
      Alert.alert("Couldn't send it to Poke", e instanceof Error ? e.message : "");
    } finally {
      setSending(false);
    }
  };

  const messages = chat?.messages ?? [];
  const streaming = Object.entries(deltas).filter(([mid]) => !messages.some((m) => m.id === mid));
  const hasReply = messages.some((m) => m.role === "poke" && textOf(m));
  const ordered: Row[] = [];
  for (const m of messages) {
    if (m.role === "user") ordered.push({ key: m.id, kind: "user", text: textOf(m) });
    else if (m.role === "system") ordered.push({ key: m.id, kind: "system", text: textOf(m) });
    else
      ordered.push({
        key: m.id,
        kind: "poke",
        text: m.status === "streaming" ? (deltas[m.id] ?? textOf(m)) : textOf(m),
        blocks: blockIds(m),
      });
    // What it did for this message goes right under it, above the reply.
    for (const traced of traces)
      if (traced.trace.messageId === m.id) ordered.push({ key: traced.trace.id, kind: "trace", traced });
  }
  for (const [key, t] of streaming) ordered.push({ key, kind: "poke", text: t, blocks: [] });
  const rows = ordered.reverse();
  const tracing = traces.some((t) => t.trace.status === "running");

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <IconButton
          accessibilityLabel="Close side chat"
          onPress={() => router.back()}
          icon={(color) => <Icon name="close" size={18} color={color} strokeWidth={2.4} />}
        />
        <View style={{ flex: 1 }}>
          <Text size="callout" weight="semibold">
            Side chat
          </Text>
          <Text size="caption" color="ink3">
            Not saved
          </Text>
        </View>
        {hasReply ? (
          <Button
            tone="fill"
            size="small"
            label={sending ? "Sending…" : "Send to Poke"}
            onPress={() => void sendToPoke()}
            disabled={sending}
          />
        ) : null}
      </View>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <FlatList
          inverted
          data={rows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={{ padding: 20, gap: 18 }}
          keyboardDismissMode="interactive"
          ListHeaderComponent={
            activity !== "idle" && streaming.length === 0 && !tracing ? (
              <Shimmer size="subhead">Thinking</Shimmer>
            ) : undefined
          }
          ListEmptyComponent={
            <View style={{ transform: [{ scaleY: -1 }], alignItems: "center", paddingTop: 60, gap: 6 }}>
              <Icon name="sideChat" size={28} color={c.ink3} />
              <Text size="callout" color="ink2" align="center">
                {error ?? "Ask something quick. It stays out of the thread."}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            switch (item.kind) {
              case "user":
                return <UserMessage text={item.text} />;
              case "system":
                return (
                  <Text size="footnote" color="ink3" align="center" selectable>
                    {item.text}
                  </Text>
                );
              case "trace":
                return <TraceView trace={item.traced.trace} steps={item.traced.steps} />;
              case "poke":
                return (
                  <View style={{ gap: 12 }}>
                    {item.text ? (
                      <RichText
                        text={item.text}
                        size="body"
                        {...(handlers.openLink ? { onLink: handlers.openLink } : {})}
                      />
                    ) : null}
                    {item.blocks.map((blockId) => {
                      const block = blocks[blockId];
                      return block ? <BlockView key={blockId} block={block} handlers={handlers} /> : null;
                    })}
                  </View>
                );
            }
          }}
        />
        <View style={{ paddingBottom: Math.max(insets.bottom, 12), paddingTop: 6 }}>
          <Composer
            text={text}
            onChangeText={setText}
            placeholder="Ask on the side…"
            working={activity !== "idle"}
            onSend={() => void send()}
            onStop={() => chat && void client.cancelSideChat(chat.id).catch(() => {})}
            editable={!!chat}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
