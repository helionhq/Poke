import {
  clock,
  dayLabel,
  needsDivider,
  PokeError,
  type Block,
  type Message,
  type ThreadRow,
} from "@poke/client";
import {
  Composer,
  DayDivider,
  Grain,
  Icon,
  NavBar,
  NavSearchButton,
  NavSideChatButton,
  AgentMark,
  Shimmer,
  Text,
  Wallpaper,
  useColors,
} from "@poke/ui-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import * as Speech from "expo-speech";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Pressable, type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pickFiles, pickPhotos, scan, takePhoto, upload, type LocalFile } from "../src/lib/attach";
import { playClip, prepareAudio } from "../src/lib/audio";
import { blockHandlers } from "../src/lib/handlers";
import { usePoke, useRemote, useThread } from "../src/lib/poke";
import { useWallpaper } from "../src/lib/prefs";
import { Dictation } from "../src/lib/voice";
import { MessageRow, PendingRow, type RowCallbacks } from "../src/thread/MessageRow";
import { AddMenu, MessageMenu, SelectSheet } from "../src/thread/menus";

type Item =
  | { type: "divider"; key: string; day: string; time: string }
  | { type: "row"; key: string; row: ThreadRow; latest: boolean }
  | { type: "working"; key: string };

interface Attached {
  local: LocalFile;
  id?: string;
  error?: string;
}

/** 01 Thread: one endless thread on the wallpaper, Poke's replies as plain text, his as bubbles. */
export default function ThreadScreen() {
  const poke = usePoke();
  const store = useThread();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const scene = useWallpaper();
  const params = useLocalSearchParams<{ message?: string; draft?: string }>();
  const input = useRef<TextInputInstance>(null);
  const list = useRef<FlatList<Item>>(null);

  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; excerpt: string }>();
  const [attached, setAttached] = useState<Attached[]>([]);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ message: Message; text: string }>();
  const [selecting, setSelecting] = useState<string>();
  const [speaking, setSpeaking] = useState<string>();
  const [highlight, setHighlight] = useState<string>();

  const routines = useRemote((p) => p.client.routines(), [], ["routine.updated", "routine.deleted"]);
  const routineNames = useMemo(
    () => new Map((routines.data?.routines ?? []).map((r) => [r.id, r.title])),
    [routines.data],
  );

  const handlers = useMemo(
    () =>
      blockHandlers(poke, {
        writeOwn: (_block: Block) => input.current?.focus(),
      }),
    [poke],
  );

  // Newest first for the inverted list, with a DayDivider above each new day or long gap.
  const rows = store.rows();
  const latestReply = store.latestReplyId();
  const working = store.activity !== "idle" && !rows.some((r) => r.kind === "message" && r.streaming);
  const items = useMemo(() => {
    const out: Item[] = [];
    let previous: Message | undefined;
    for (const row of rows) {
      if (row.kind === "message") {
        if (needsDivider(previous, row.message)) {
          out.push({
            type: "divider",
            key: `d-${row.message.id}`,
            day: dayLabel(row.message.createdAt),
            time: clock(row.message.createdAt),
          });
        }
        previous = row.message;
        out.push({ type: "row", key: row.message.id, row, latest: row.message.id === latestReply });
      } else out.push({ type: "row", key: row.entry.clientMessageId, row, latest: false });
    }
    if (working) out.push({ type: "working", key: "working" });
    return out.reverse();
  }, [store.version, latestReply, working]);

  // Deep link: poke://thread?message=… scrolls to that message and flashes it. One that isn't
  // loaded yet is fetched, and the jump happens once it's among the rows.
  const [jumpTo, setJumpTo] = useState<string>();
  useEffect(() => {
    const id = params.message;
    if (!id) return;
    setJumpTo(id);
    if (!items.some((i) => i.type === "row" && i.key === id)) {
      void poke.client.messages({ around: id, limit: 50 }).then(
        (page) => store.addLookup(page),
        () => setJumpTo(undefined),
      );
    }
    router.setParams({ message: undefined });
  }, [params.message]);
  useEffect(() => {
    if (!jumpTo) return;
    const index = items.findIndex((i) => i.type === "row" && i.key === jumpTo);
    if (index < 0) return;
    setJumpTo(undefined);
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setHighlight(jumpTo);
    setTimeout(() => setHighlight(undefined), 2200);
  }, [items, jumpTo]);

  // "+" on Routines or Skills: open the thread with a starter sentence to finish.
  useEffect(() => {
    if (!params.draft) return;
    setText(params.draft);
    router.setParams({ draft: undefined });
    setTimeout(() => input.current?.focus(), 350);
  }, [params.draft]);

  const addFiles = useCallback(
    async (files: LocalFile[]) => {
      if (files.length === 0) return;
      setAttached((old) => [...old, ...files.map((local) => ({ local }))]);
      for (const local of files) {
        try {
          const attachment = await upload(poke.client, local);
          setAttached((old) => old.map((a) => (a.local === local ? { ...a, id: attachment.id } : a)));
        } catch (error) {
          setAttached((old) =>
            old.map((a) =>
              a.local === local
                ? { ...a, error: error instanceof Error ? error.message : "Upload failed" }
                : a,
            ),
          );
        }
      }
    },
    [poke.client],
  );

  const onPick = async (source: "camera" | "photos" | "files" | "scan" | LocalFile) => {
    setAdding(false);
    try {
      const files =
        typeof source === "object"
          ? [source]
          : source === "camera"
            ? await takePhoto()
            : source === "photos"
              ? await pickPhotos()
              : source === "files"
                ? await pickFiles()
                : await scan();
      await addFiles(files);
    } catch (error) {
      Alert.alert("Couldn't add that", error instanceof Error ? error.message : "");
    }
  };

  // Dictation: the mic streams to the server and the words land in the field as he speaks.
  const dictation = useRef<Dictation>(undefined);
  const [dictating, setDictating] = useState(false);
  const toggleDictation = async () => {
    if (dictation.current) {
      await dictation.current.stop();
      return;
    }
    const session = new Dictation(poke.client, text, setText, (error) => {
      if (dictation.current === session) dictation.current = undefined;
      setDictating(false);
      if (error) Alert.alert("Dictation stopped", error);
    });
    dictation.current = session;
    setDictating(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await session.start().catch((error: unknown) => {
      dictation.current = undefined;
      setDictating(false);
      Alert.alert("Can't dictate", error instanceof Error ? error.message : "");
    });
  };
  useEffect(() => () => void dictation.current?.stop(), []);

  const uploading = attached.some((a) => !a.id && !a.error);
  const send = async () => {
    // Sending mid-dictation keeps the last words.
    const body = (dictation.current ? await dictation.current.stop() : text).trim();
    const ids = attached.flatMap((a) => (a.id ? [a.id] : []));
    if ((!body && ids.length === 0) || uploading) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setText("");
    setAttached([]);
    setReplyTo(undefined);
    await poke.send({ text: body, attachmentIds: ids, ...(replyTo ? { replyTo: replyTo.id } : {}) });
    list.current?.scrollToOffset({ offset: 0, animated: true });
  };

  // Read aloud in the chosen AssemblyAI voice (the server caches each clip). Before voice is set
  // up on the server, the iPhone's own voice reads it instead.
  const playing = useRef<{ id: string; stop(): void }>(undefined);
  const speak = async (message: Message, words: string) => {
    const current = playing.current;
    playing.current = undefined;
    current?.stop();
    void Speech.stop();
    if (current?.id === message.id || speaking === message.id) {
      setSpeaking(undefined);
      return;
    }
    setSpeaking(message.id);
    const done = () => setSpeaking((id) => (id === message.id ? undefined : id));
    try {
      const wav = await poke.client.tts(message.id);
      if (!(await prepareAudio("playback"))) return done();
      const clip = await playClip(wav);
      playing.current = { id: message.id, stop: clip.stop };
      void clip.done.then(() => {
        if (playing.current?.id === message.id) playing.current = undefined;
        done();
      });
    } catch (error) {
      if (error instanceof PokeError && error.code === "unavailable") {
        Speech.speak(words.replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"), {
          onDone: done,
          onStopped: done,
        });
        return;
      }
      done();
      Alert.alert("Couldn't read that aloud", error instanceof Error ? error.message : "");
    }
  };
  useEffect(() => () => playing.current?.stop(), []);

  const cb: RowCallbacks = {
    onLongPress: (message, t) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setMenu({ message, text: t });
    },
    onSpeak: (message, words) => void speak(message, words),
    ...(speaking ? { speakingId: speaking } : {}),
    routineName: (id) => routineNames.get(id),
    handlers,
  };

  const renderItem = ({ item }: { item: Item }) => {
    if (item.type === "divider") return <DayDivider day={item.day} time={item.time} />;
    if (item.type === "working")
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <AgentMark size="xs" state="active" />
          <Shimmer size="subhead">{store.activity === "working" ? "Working on it" : "Thinking"}</Shimmer>
        </View>
      );
    const row = item.row;
    if (row.kind === "pending")
      return (
        <PendingRow
          entry={row.entry}
          onRetry={() => void poke.outbox.retry(row.entry.clientMessageId)}
          onDiscard={() => void poke.outbox.discard(row.entry.clientMessageId)}
        />
      );
    return (
      <MessageRow
        message={row.message}
        text={row.text}
        streaming={row.streaming}
        latest={item.latest}
        highlighted={highlight === row.message.id}
        cb={cb}
      />
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <Wallpaper scene={scene} />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <FlatList
          ref={list}
          inverted
          data={items}
          keyExtractor={(i) => i.key}
          renderItem={renderItem}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 16,
            paddingBottom: insets.top + 120,
            gap: 18,
          }}
          onEndReached={() => void poke.loadOlder().catch(() => {})}
          onEndReachedThreshold={0.6}
          onScrollToIndexFailed={(info) =>
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })
          }
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          ListEmptyComponent={
            <View style={{ alignItems: "center", gap: 8, transform: [{ scaleY: -1 }], paddingTop: 80 }}>
              <AgentMark size="xl" />
              <Text size="callout" color="ink2" align="center">
                {poke.status === "open"
                  ? "Say hi. Poke keeps one thread with you, forever."
                  : "Connecting to Poke…"}
              </Text>
            </View>
          }
        />
        <View style={{ paddingBottom: Math.max(insets.bottom, 12), paddingTop: 6, gap: 8 }}>
          {replyTo || attached.length > 0 ? (
            <View style={{ marginHorizontal: 16, gap: 6 }}>
              {replyTo ? (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 14,
                    backgroundColor: c.card,
                  }}
                >
                  <Icon name="reply" size={14} color={c.ink3} />
                  <Text size="footnote" color="ink2" numberOfLines={1} style={{ flex: 1 }}>
                    {replyTo.excerpt}
                  </Text>
                  <Pressable
                    onPress={() => setReplyTo(undefined)}
                    accessibilityLabel="Cancel reply"
                    hitSlop={8}
                  >
                    <Icon name="close" size={14} color={c.ink3} />
                  </Pressable>
                </View>
              ) : null}
              {attached.length > 0 ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {attached.map((a, i) => (
                    <Pressable
                      key={`${a.local.uri}-${i}`}
                      onPress={() => setAttached((old) => old.filter((x) => x !== a))}
                      accessibilityLabel={`Remove ${a.local.name}`}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 6,
                        paddingHorizontal: 10,
                        height: 30,
                        borderRadius: 999,
                        backgroundColor: c.card,
                        borderWidth: 1,
                        borderColor: a.error ? c.red : c.separator,
                      }}
                    >
                      <Icon name={a.local.kind === "image" ? "image" : "file"} size={14} color={c.ink2} />
                      <Text
                        size="footnote"
                        numberOfLines={1}
                        style={{ maxWidth: 160 }}
                        color={a.error ? "red" : a.id ? "ink" : "ink3"}
                      >
                        {a.error ? "Didn't upload" : a.local.name}
                      </Text>
                      <Icon name="close" size={12} color={c.ink3} />
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
          <Composer
            ref={input}
            text={text}
            onChangeText={setText}
            {...(attached.some((a) => a.id) && !text.trim() ? { state: "typing" as const } : {})}
            working={store.activity !== "idle"}
            onPlus={() => setAdding(true)}
            dictating={dictating}
            onMic={() => void toggleDictation()}
            onVoice={() => router.push("/voice")}
            onSend={() => void send()}
            onStop={() => void poke.client.stop().catch(() => {})}
          />
        </View>
      </KeyboardAvoidingView>
      <NavBar
        style={{ position: "absolute", top: 0, left: 0, right: 0 }}
        inset={insets.top}
        backdrop="clear"
        title="Poke"
        {...(poke.status !== "open" ? { subtitle: "Offline" } : {})}
        onTitlePress={() => router.push("/agent")}
        leading={<NavSearchButton onPress={() => router.push("/search")} />}
        trailing={<NavSideChatButton onPress={() => router.push("/sidechat")} />}
      />
      <Grain />
      <AddMenu
        visible={adding}
        onClose={() => setAdding(false)}
        onPick={(s) => void onPick(s)}
        onLibrary={() => {
          setAdding(false);
          router.push("/library");
        }}
      />
      <MessageMenu
        {...(menu ? { target: menu } : {})}
        onClose={() => setMenu(undefined)}
        onCopy={() => {
          if (menu) void Clipboard.setStringAsync(menu.text);
          setMenu(undefined);
        }}
        onSelect={() => {
          setSelecting(menu?.text);
          setMenu(undefined);
        }}
        onReply={() => {
          if (menu) setReplyTo({ id: menu.message.id, excerpt: menu.text.slice(0, 140) });
          setMenu(undefined);
          setTimeout(() => input.current?.focus(), 250);
        }}
      />
      <SelectSheet
        {...(selecting !== undefined ? { text: selecting } : {})}
        onClose={() => setSelecting(undefined)}
      />
    </View>
  );
}
