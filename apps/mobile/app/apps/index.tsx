import type { CatalogApp, Integration } from "@poke/client";
import { Chip, Glass, Icon, ListGroup, ListRow, Logo, useColors } from "@poke/ui-native";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { connectApp } from "../../src/lib/connect";
import { usePoke, useRemote } from "../../src/lib/poke";
import { Footnote, Screen } from "../../src/ui/Screen";

const POPULAR = [
  "gmail",
  "google-calendar",
  "googlecalendar",
  "slack",
  "notion",
  "github",
  "linear",
  "google-drive",
  "googledrive",
  "spotify",
];

/** 19 Connect an app: Executor's catalog, what's connected, and local MCP servers. */
export default function AppsScreen() {
  const { client } = usePoke();
  const c = useColors();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>();
  const connected = useRemote((p) => p.client.integrations(), [], ["integration.updated"]);
  const catalog = useRemote((p) => p.client.catalog(), []);
  const servers = useRemote((p) => p.client.mcpServers(), [], ["integration.updated"]);

  const byId = useMemo(
    () => new Map((connected.data?.integrations ?? []).map((i) => [i.id, i])),
    [connected.data],
  );
  const apps = catalog.data?.apps ?? [];
  const categories = useMemo(
    () => [...new Set(apps.flatMap((a) => (a.category ? [a.category] : [])))].sort(),
    [apps],
  );
  const needle = q.trim().toLowerCase();
  const filtered = apps.filter(
    (a) =>
      (!category || a.category === category) &&
      (!needle || a.name.toLowerCase().includes(needle) || a.description?.toLowerCase().includes(needle)),
  );
  const browsing = !!needle || !!category;
  const popular = browsing ? filtered : filtered.filter((a) => POPULAR.includes(a.id) || byId.has(a.id));
  const rest = browsing ? [] : filtered.filter((a) => !popular.includes(a));
  const yours = (connected.data?.integrations ?? []).filter((i) => !apps.some((a) => a.id === i.id));

  const row = (app: CatalogApp | Integration) => {
    const integration = byId.get(app.id);
    const isConnected = integration?.accounts.some((a) => a.status === "connected");
    const description = "description" in app ? app.description : undefined;
    return (
      <ListRow
        key={app.id}
        tile="logo"
        title={app.name}
        {...(description ? { subtitle: description } : {})}
        icon={
          <Logo
            mark={{ app: app.id, name: app.name, ...(app.icon ? { icon: app.icon } : {}) }}
            size={20}
            radius={5}
          />
        }
        {...(isConnected
          ? {
              value: "Connected",
              onPress: () => router.push({ pathname: "/apps/[id]", params: { id: app.id } }),
            }
          : { accessory: "connect" as const, onConnect: () => void connectApp(client, app.id) })}
      />
    );
  };

  const notConfigured = connected.data && !connected.data.executor.configured;
  return (
    <Screen
      title="Connect an app"
      subtitle="Poke works in your apps the way you would, and asks before anything risky."
      loading={(catalog.loading && !catalog.data) || (connected.loading && !connected.data)}
      {...(catalog.error || connected.error ? { error: catalog.error ?? connected.error } : {})}
      onRefresh={() => {
        void catalog.reload();
        void connected.reload();
        void servers.reload();
      }}
    >
      <View style={{ paddingHorizontal: 16, gap: 12 }}>
        <Glass dense style={{ borderRadius: 14 }}>
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 8, height: 44, paddingHorizontal: 14 }}
          >
            <Icon name="search" size={17} color={c.ink2} strokeWidth={2} />
            <TextInput
              value={q}
              onChangeText={setQ}
              placeholder="Search apps"
              placeholderTextColor={c.ink3}
              autoCorrect={false}
              accessibilityLabel="Search apps"
              style={{ flex: 1, fontFamily: "OpenRunde-Regular", fontSize: 16, color: c.ink }}
            />
          </View>
        </Glass>
      </View>
      {categories.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
          style={{ marginTop: -8 }}
        >
          <Chip
            label="All"
            state={!category ? "selected" : "default"}
            onPress={() => setCategory(undefined)}
          />
          {categories.map((cat) => (
            <Chip
              key={cat}
              label={cat}
              state={category === cat ? "selected" : "default"}
              onPress={() => setCategory(category === cat ? undefined : cat)}
            />
          ))}
        </ScrollView>
      ) : null}
      {notConfigured ? (
        <Footnote>Apps connect through Executor, which isn't set up on your server yet.</Footnote>
      ) : null}
      {yours.length > 0 && !browsing ? <ListGroup header="Connected">{yours.map(row)}</ListGroup> : null}
      {popular.length > 0 ? (
        <ListGroup header={browsing ? "Results" : "Popular"}>{popular.map(row)}</ListGroup>
      ) : null}
      {rest.length > 0 ? <ListGroup header="More apps">{rest.slice(0, 80).map(row)}</ListGroup> : null}
      <ListGroup header="Your own" footer="An MCP server gives Poke tools that aren't in the catalog.">
        {(servers.data?.servers ?? []).map((s) => (
          <ListRow
            key={s.id}
            tile="ink"
            title={s.name}
            subtitle={
              s.error
                ? "Can't reach it right now"
                : s.toolCount !== undefined
                  ? `${s.toolCount} tools`
                  : s.transport.kind === "http"
                    ? s.transport.url
                    : s.transport.command
            }
            icon={(color) => <Icon name="server" size={16} color={color} />}
            onPress={() => router.push({ pathname: "/apps/[id]", params: { id: s.id, mcp: "1" } })}
          />
        ))}
        <ListRow
          tile="paper"
          title="Add an MCP server"
          icon={(color) => <Icon name="plus" size={16} color={color} strokeWidth={2.4} />}
          onPress={() => router.push("/apps/mcp")}
        />
      </ListGroup>
    </Screen>
  );
}
