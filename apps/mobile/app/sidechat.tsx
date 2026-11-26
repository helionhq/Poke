import { type Message, type SideChatView } from "@poke/client";
import {
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
import { useEffect, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePoke } from "../src/lib/poke";

const textOf = (m: Message) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");

/**
 * 09 Side chat: a quick question on the side that doesn't touch the main thread. It lives only
 * while open; "Send to Poke" hands the answer to the thread.
 */
export default function SideChatScreen() {
  const { client, onEvent } = usePoke();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [chat, setChat] = useState<SideChatView>();
  const [error, setError] = useState<string>();
  const [text, setText] = useState("");
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [activity, setActivity] = useState<"idle" | "thinking" | "working">("idle");
  const [sending, setSending] = useState(false);
  const id = useRef<string>(undefined);

  useEffect(() => {
    let alive = true;
    client.openSideChat().then(
      ({ sideChat }) => {
        id.current = sideChat.id;
        if (alive) setChat(sideChat);
        else void client.closeSideChat(sideChat.id).catch(() => {});
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
        setDeltas((d) => {
          const { [event.message.id]: _, ...rest } = d;
          return rest;
        });
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
  const hasReply = messages.some((m) => m.role === "poke");
  type Row = { key: string; role: "user" | "poke"; text: string };
  const rows: Row[] = [
    ...messages.map((m) => ({
      key: m.id,
      role: m.role === "user" ? ("user" as const) : ("poke" as const),
      text: textOf(m),
    })),
    ...streaming.map(([key, t]) => ({ key, role: "poke" as const, text: t })),
  ].reverse();

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
            activity !== "idle" && streaming.length === 0 ? (
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
          renderItem={({ item }) =>
            item.role === "user" ? (
              <UserMessage text={item.text} />
            ) : (
              <RichText text={item.text} size="body" />
            )
          }
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
