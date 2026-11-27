import { clock, dayLabel, type SearchResponse } from "@poke/client";
import {
  AgentMark,
  Chip,
  Icon,
  IconButton,
  Glass,
  SearchResult,
  Text,
  useColors,
  useCardStyle,
} from "@poke/ui-native";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePoke } from "../src/lib/poke";
import { snippet } from "../src/lib/text";

const FILTERS = [
  ["all", "All"],
  ["messages", "Messages"],
  ["tasks", "Tasks"],
  ["links", "Links"],
  ["photos", "Photos"],
] as const;
type Filter = (typeof FILTERS)[number][0];

/** 04 Search the thread: filters, what Poke remembers about it, hits grouped by day. */
export default function SearchScreen() {
  const { client } = usePoke();
  const c = useColors();
  const card = useCardStyle();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [hits, setHits] = useState<SearchResponse["hits"]>();
  const [history, setHistory] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits(undefined);
      setHistory(undefined);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setBusy(true);
      client
        .search(query, filter)
        .then(
          (res) => {
            if (!alive) return;
            setHits(res.hits);
            setError(undefined);
          },
          (e: unknown) => alive && setError(e instanceof Error ? e.message : "Search didn't work"),
        )
        .finally(() => alive && setBusy(false));
      // What Poke remembers about it (memory), only for the full thread view.
      if (filter === "all" && query.length >= 3)
        client.recall(query).then(
          (res) => alive && setHistory(res.answer.trim() || undefined),
          () => alive && setHistory(undefined),
        );
    }, 280);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q, filter, client]);

  const groups = useMemo(() => {
    const out: Array<{ day: string; hits: SearchResponse["hits"] }> = [];
    for (const hit of hits ?? []) {
      const day = dayLabel(hit.createdAt);
      const last = out.at(-1);
      if (last && last.day === day) last.hits.push(hit);
      else out.push({ day, hits: [hit] });
    }
    return out;
  }, [hits]);

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 16,
          flexDirection: "row",
          gap: 10,
          alignItems: "center",
        }}
      >
        <Glass dense style={{ flex: 1, borderRadius: 24 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              height: 48,
              paddingLeft: 16,
              paddingRight: 8,
            }}
          >
            <Icon name="search" size={18} color={c.ink2} strokeWidth={2} />
            <TextInput
              value={q}
              onChangeText={setQ}
              autoFocus
              placeholder="Search the thread"
              placeholderTextColor={c.ink3}
              returnKeyType="search"
              accessibilityLabel="Search the thread"
              style={{ flex: 1, fontFamily: "OpenRunde-Regular", fontSize: 17, color: c.ink }}
            />
            {q ? (
              <IconButton
                tone="fill"
                size="small"
                accessibilityLabel="Clear"
                onPress={() => setQ("")}
                icon={(color) => <Icon name="close" size={14} color={color} strokeWidth={2.4} />}
              />
            ) : null}
          </View>
        </Glass>
        <IconButton
          accessibilityLabel="Close search"
          onPress={() => router.back()}
          icon={(color) => <Icon name="close" size={20} color={color} strokeWidth={2.2} />}
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 14 }}
      >
        {FILTERS.map(([key, label]) => (
          <Chip
            key={key}
            label={label}
            state={filter === key ? "selected" : "default"}
            onPress={() => setFilter(key)}
          />
        ))}
      </ScrollView>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 24, gap: 14 }}
        keyboardDismissMode="on-drag"
      >
        {history ? (
          <View style={[card, { borderRadius: 20, padding: 16, gap: 8 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <AgentMark size="xs" />
              <Text size="footnote" weight="semibold">
                From your history
              </Text>
              {hits?.length ? (
                <Text size="footnote" color="ink3">
                  · {hits.length} {hits.length === 1 ? "mention" : "mentions"}
                </Text>
              ) : null}
            </View>
            <Text size="callout" lineHeight={22} selectable>
              {history}
            </Text>
          </View>
        ) : null}
        {busy && !hits ? <ActivityIndicator color={c.ink3} style={{ marginTop: 24 }} /> : null}
        {error ? (
          <Text size="subhead" color="ink2">
            {error}
          </Text>
        ) : null}
        {hits && hits.length === 0 && !busy ? (
          <Text size="subhead" color="ink2" align="center" style={{ marginTop: 32 }}>
            Nothing in the thread matches that.
          </Text>
        ) : null}
        {groups.map((group) => (
          <View key={group.day}>
            <Text family="display" size="title2" lineHeight={30} style={{ marginTop: 10 }}>
              {group.day}
            </Text>
            {group.hits.map((hit) => (
              <SearchResult
                key={hit.messageId}
                who={hit.role === "user" ? "You" : "Poke"}
                when={clock(hit.createdAt)}
                snippet={snippet(hit.highlight)}
                onPress={() => router.dismissTo({ pathname: "/", params: { message: hit.messageId } })}
              />
            ))}
          </View>
        ))}
      </ScrollView>
      {!q ? (
        <Pressable
          onPress={() => router.back()}
          style={{ position: "absolute", bottom: insets.bottom + 16, alignSelf: "center" }}
          accessibilityRole="button"
        >
          <Text size="footnote" color="ink3">
            Search everything you and Poke have said
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
