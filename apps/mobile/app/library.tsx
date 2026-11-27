import { fileSize, type Attachment, type WorkspaceEntry } from "@poke/client";
import { Chip, Glass, Icon, ListGroup, ListRow, Text, useColors } from "@poke/ui-native";
import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { router } from "expo-router";
import * as Sharing from "expo-sharing";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePoke, useRemote } from "../src/lib/poke";
import { Empty, Screen } from "../src/ui/Screen";

type Tab = "all" | "photos" | "files" | "from_poke" | "workspace";
const TABS: [Tab, string][] = [
  ["all", "All"],
  ["photos", "Photos"],
  ["files", "Files"],
  ["from_poke", "From Poke"],
  ["workspace", "Workspace"],
];

/** The Library (brief §16): everything sent in the thread, and Poke's workspace as folders. */
export default function LibraryScreen() {
  const c = useColors();
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Screen title="Library" subtitle="Photos, files and scans from the thread, and what Poke made.">
      {tab !== "workspace" ? (
        <View style={{ paddingHorizontal: 16 }}>
          <Glass dense style={{ borderRadius: 14 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                height: 44,
                paddingHorizontal: 14,
              }}
            >
              <Icon name="search" size={17} color={c.ink2} strokeWidth={2} />
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder="Search the library"
                placeholderTextColor={c.ink3}
                autoCorrect={false}
                accessibilityLabel="Search the library"
                style={{ flex: 1, fontFamily: "OpenRunde-Regular", fontSize: 16, color: c.ink }}
              />
            </View>
          </Glass>
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
        style={{ marginTop: -8 }}
      >
        {TABS.map(([key, label]) => (
          <Chip
            key={key}
            label={label}
            state={tab === key ? "selected" : "default"}
            onPress={() => setTab(key)}
          />
        ))}
      </ScrollView>
      {tab === "workspace" ? <Workspace /> : <Attachments filter={tab} query={query} />}
    </Screen>
  );
}

function Attachments({ filter, query }: { filter: Exclude<Tab, "workspace">; query: string }) {
  const { client } = usePoke();
  const c = useColors();
  const { width } = useWindowDimensions();
  const list = useRemote(
    (p) => p.client.library({ filter, ...(query ? { q: query } : {}), limit: 120 }),
    [filter, query],
  );
  const [preview, setPreview] = useState<Attachment>();
  const items = list.data?.attachments ?? [];
  const photos = items.filter((a) => a.kind === "image" || a.kind === "scan");
  const files = items.filter((a) => !(a.kind === "image" || a.kind === "scan"));
  const tile = (width - 32 - 8) / 3;
  const headers = client.authHeaders();

  if (list.loading && !list.data) return <ActivityIndicator style={{ marginTop: 24 }} color={c.ink3} />;
  if (list.error)
    return (
      <Empty
        title="Couldn't load the library"
        body={list.error}
        action={{ label: "Try again", onPress: () => void list.reload() }}
      />
    );
  if (items.length === 0)
    return (
      <Empty
        title={query ? "Nothing matches that" : "Nothing here yet"}
        body={query ? undefined : "Photos and files you send Poke show up here."}
      />
    );
  return (
    <>
      {photos.length > 0 && filter !== "files" ? (
        <View style={{ paddingHorizontal: 16, flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {photos.map((a) => (
            <Pressable key={a.id} onPress={() => setPreview(a)} accessibilityLabel={a.name}>
              <Image
                source={{ uri: client.attachmentUrl(a.id), headers }}
                style={{ width: tile, height: tile, borderRadius: 10, backgroundColor: c.fill }}
                contentFit="cover"
                recyclingKey={a.id}
              />
            </Pressable>
          ))}
        </View>
      ) : null}
      {files.length > 0 && filter !== "photos" ? (
        <ListGroup header={photos.length ? "Files" : undefined}>
          {files.map((a) => (
            <ListRow
              key={a.id}
              tile={a.origin === "poke" ? "purple" : "paper"}
              title={a.name}
              subtitle={`${fileSize(a.size)} · ${new Date(a.createdAt).toLocaleDateString()}${a.origin === "poke" ? " · from Poke" : ""}`}
              icon={(color) => <Icon name="file" size={16} color={color} />}
              onPress={() => setPreview(a)}
            />
          ))}
        </ListGroup>
      ) : null}
      {preview ? <Preview attachment={preview} onClose={() => setPreview(undefined)} /> : null}
    </>
  );
}

/** Downloads a file through Poke (with this phone's token) and opens the share sheet. */
async function shareFrom(url: string, name: string, headers: Record<string, string>): Promise<void> {
  try {
    const target = new File(Paths.cache, `${Date.now()}-${name.replace(/[/\\]/g, "_")}`);
    const file = await File.downloadFileAsync(url, target, { headers });
    await Sharing.shareAsync(file.uri, { dialogTitle: name });
  } catch (e) {
    Alert.alert("Couldn't share it", e instanceof Error ? e.message : "");
  }
}

function Preview({ attachment, onClose }: { attachment: Attachment; onClose(): void }) {
  const { client } = usePoke();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const headers = client.authHeaders();
  const isImage = attachment.kind === "image" || attachment.kind === "scan";
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.groundGrouped, paddingBottom: insets.bottom + 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 16, gap: 12 }}>
          <Text size="callout" weight="semibold" numberOfLines={1} style={{ flex: 1 }}>
            {attachment.name}
          </Text>
          <Text size="callout" weight="medium" color="link" onPress={onClose} accessibilityRole="button">
            Done
          </Text>
        </View>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
          {isImage ? (
            <Image
              source={{ uri: client.attachmentUrl(attachment.id), headers }}
              style={{ width: "100%", height: "100%" }}
              contentFit="contain"
            />
          ) : (
            <View style={{ alignItems: "center", gap: 10 }}>
              <Icon name="file" size={48} color={c.ink3} />
              <Text size="subhead" color="ink2">
                {fileSize(attachment.size)}
              </Text>
            </View>
          )}
        </View>
        <ListGroup>
          <ListRow
            tile="none"
            title="Share"
            accessory="none"
            onPress={() => void shareFrom(client.attachmentUrl(attachment.id), attachment.name, headers)}
          />
          {attachment.messageId ? (
            <ListRow
              tile="none"
              title="Show in thread"
              accessory="none"
              onPress={() => {
                onClose();
                router.dismissTo({ pathname: "/", params: { message: attachment.messageId! } });
              }}
            />
          ) : null}
        </ListGroup>
      </View>
    </Modal>
  );
}

function Workspace() {
  const { client } = usePoke();
  const [path, setPath] = useState("");
  const listing = useRemote((p) => p.client.workspace(path), [path]);
  const entries = listing.data?.entries ?? [];
  const parts = path ? path.split("/") : [];
  const open = (e: WorkspaceEntry) => {
    if (e.kind === "dir") setPath(e.path);
    else void shareFrom(client.workspaceFileUrl(e.path), e.name, client.authHeaders());
  };
  return (
    <>
      {parts.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 20, alignItems: "center" }}
          style={{ marginTop: -8 }}
        >
          <Text size="footnote" weight="medium" color="link" onPress={() => setPath("")}>
            Workspace
          </Text>
          {parts.map((part, i) => (
            <Text
              key={i}
              size="footnote"
              color={i === parts.length - 1 ? "ink" : "link"}
              onPress={() => setPath(parts.slice(0, i + 1).join("/"))}
            >
              {" / "}
              {part}
            </Text>
          ))}
        </ScrollView>
      ) : null}
      {listing.error ? (
        <Empty
          title="Couldn't open that folder"
          body={listing.error}
          action={{ label: "Try again", onPress: () => void listing.reload() }}
        />
      ) : null}
      {listing.data && entries.length === 0 ? <Empty title="Empty folder" /> : null}
      {entries.length > 0 ? (
        <ListGroup footer={path ? undefined : "Where Poke's agents keep their work. Tap a file to share it."}>
          {entries.map((e) => (
            <ListRow
              key={e.path}
              tile={e.kind === "dir" ? "blue" : "paper"}
              title={e.name}
              subtitle={
                e.kind === "file"
                  ? `${fileSize(e.size ?? 0)} · ${new Date(e.modifiedAt).toLocaleDateString()}`
                  : undefined
              }
              icon={(color) => <Icon name={e.kind === "dir" ? "library" : "file"} size={16} color={color} />}
              accessory={e.kind === "dir" ? "chevron" : "none"}
              onPress={() => open(e)}
            />
          ))}
        </ListGroup>
      ) : null}
    </>
  );
}
