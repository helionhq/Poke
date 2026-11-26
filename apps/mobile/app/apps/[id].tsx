import type { Integration, IntegrationAccount } from "@poke/client";
import { Icon, ListGroup, ListRow, Logo, Text, useColors } from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, View } from "react-native";
import { connectApp } from "../../src/lib/connect";
import { usePoke, useRemote } from "../../src/lib/poke";
import { Screen } from "../../src/ui/Screen";

/** 20 An app's accounts and what Poke may do there. Also shows a local MCP server (?mcp=1). */
export default function IntegrationScreen() {
  const { id, mcp } = useLocalSearchParams<{ id: string; mcp?: string }>();
  return mcp ? <McpServerDetail id={id} /> : <AppDetail id={id} />;
}

function Header({
  id,
  name,
  icon,
  description,
}: {
  id: string;
  name: string;
  icon?: string;
  description?: string;
}) {
  const c = useColors();
  return (
    <View style={{ paddingHorizontal: 20, gap: 10 }}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          backgroundColor: c.card,
          borderWidth: 1,
          borderColor: c.separator,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Logo mark={{ app: id, name, ...(icon ? { icon } : {}) }} size={40} radius={9} />
      </View>
      <Text family="display" size="largeTitle" lineHeight={40} accessibilityRole="header">
        {name}
      </Text>
      {description ? (
        <Text size="subhead" color="ink2" lineHeight={21}>
          {description}
        </Text>
      ) : null}
    </View>
  );
}

function AppDetail({ id }: { id: string }) {
  const { client } = usePoke();
  const list = useRemote((p) => p.client.integrations(), [], ["integration.updated"]);
  const catalog = useRemote((p) => p.client.catalog(), []);
  const integration = list.data?.integrations.find((i) => i.id === id);
  const app = catalog.data?.apps.find((a) => a.id === id);
  const name = integration?.name ?? app?.name ?? id;

  const update = async (body: Parameters<typeof client.updateIntegration>[1]) => {
    try {
      const res = await client.updateIntegration(id, body);
      list.setData(
        (old) =>
          old && { ...old, integrations: old.integrations.map((i) => (i.id === id ? res.integration : i)) },
      );
      void Haptics.selectionAsync();
    } catch (e) {
      Alert.alert("Couldn't change that", e instanceof Error ? e.message : "");
    }
  };

  const disconnect = async (accounts: IntegrationAccount[]) => {
    try {
      for (const a of accounts) await client.disconnect(id, a.id);
      void list.reload();
      if (accounts.length === integration?.accounts.length) router.back();
    } catch (e) {
      Alert.alert("Couldn't disconnect", e instanceof Error ? e.message : "");
    }
  };

  const accountMenu = (account: IntegrationAccount, isDefault: boolean) =>
    Alert.alert(account.identity ?? account.label, undefined, [
      ...(isDefault
        ? []
        : [{ text: "Make default", onPress: () => void update({ defaultAccountId: account.id }) }]),
      { text: "Disconnect", style: "destructive" as const, onPress: () => void disconnect([account]) },
      { text: "Cancel", style: "cancel" as const },
    ]);

  const confirmDisconnectAll = (i: Integration) =>
    Alert.alert(`Disconnect ${i.name}?`, "Poke won't be able to use it until you connect it again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: () => void disconnect(i.accounts) },
    ]);

  return (
    <Screen
      header={
        <Header
          id={id}
          name={name}
          {...((integration?.icon ?? app?.icon) ? { icon: integration?.icon ?? app?.icon } : {})}
          {...(app?.description ? { description: app.description } : {})}
        />
      }
      loading={list.loading && !list.data}
      {...(list.error ? { error: list.error } : {})}
    >
      {integration ? (
        <>
          <ListGroup header="Accounts">
            {integration.accounts.map((a) => {
              const isDefault = a.id === integration.defaultAccountId;
              return (
                <ListRow
                  key={a.id}
                  tile="none"
                  title={a.identity ?? a.label}
                  {...(a.status === "error"
                    ? { subtitle: "Needs signing in again" }
                    : a.status === "pending"
                      ? { subtitle: "Finishing sign-in…" }
                      : {})}
                  {...(isDefault && integration.accounts.length > 1 ? { value: "Default" } : {})}
                  onPress={() => accountMenu(a, isDefault)}
                />
              );
            })}
            <ListRow
              tile="none"
              title="Add another account"
              accessory="none"
              onPress={() => void connectApp(client, id)}
            />
          </ListGroup>
          {integration.capabilities.length > 0 ? (
            <ListGroup
              header="What Poke can do"
              footer="“Asks first” comes from the app's own rules: Poke shows you the details and waits for your OK."
            >
              {integration.capabilities.map((cap) =>
                cap.mode === "ask" ? (
                  <ListRow
                    key={cap.id}
                    tile="none"
                    title={cap.label}
                    value="Asks first"
                    onPress={() => router.push("/approvals")}
                  />
                ) : (
                  <ListRow
                    key={cap.id}
                    tile="none"
                    title={cap.label}
                    accessory={cap.mode === "on" ? "toggle-on" : "toggle-off"}
                    onToggle={(on) => void update({ capability: { id: cap.id, mode: on ? "on" : "off" } })}
                  />
                ),
              )}
            </ListGroup>
          ) : null}
          <ListGroup>
            <ListRow
              tile="none"
              title={`Disconnect ${integration.name}`}
              accessory="none"
              destructive
              onPress={() => confirmDisconnectAll(integration)}
            />
          </ListGroup>
        </>
      ) : list.data ? (
        <ListGroup>
          <ListRow
            tile="none"
            title={`Connect ${name}`}
            accessory="none"
            onPress={() => void connectApp(client, id)}
          />
        </ListGroup>
      ) : null}
    </Screen>
  );
}

function McpServerDetail({ id }: { id: string }) {
  const { client } = usePoke();
  const servers = useRemote((p) => p.client.mcpServers(), [], ["integration.updated"]);
  const server = servers.data?.servers.find((s) => s.id === id);
  const remove = () =>
    Alert.alert(`Remove ${server?.name ?? id}?`, "Poke loses these tools.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await client.removeMcpServer(id);
            router.back();
          } catch (e) {
            Alert.alert("Couldn't remove it", e instanceof Error ? e.message : "");
          }
        },
      },
    ]);
  return (
    <Screen
      title={server?.name ?? id}
      subtitle={
        server
          ? server.transport.kind === "http"
            ? server.transport.url
            : `${server.transport.command} ${server.transport.args.join(" ")}`
          : undefined
      }
      loading={servers.loading && !servers.data}
      {...(servers.error ? { error: servers.error } : {})}
    >
      {server ? (
        <>
          <ListGroup>
            <ListRow
              tile="ink"
              title={server.connected ? "Connected" : "Not connected"}
              subtitle={
                server.error ?? (server.toolCount !== undefined ? `${server.toolCount} tools` : undefined)
              }
              icon={(color) => <Icon name="server" size={16} color={color} />}
              accessory="none"
            />
          </ListGroup>
          <ListGroup>
            <ListRow tile="none" title="Remove server" accessory="none" destructive onPress={remove} />
          </ListGroup>
        </>
      ) : null}
    </Screen>
  );
}
