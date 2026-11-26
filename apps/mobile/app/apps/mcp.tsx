import type { McpServer } from "@poke/client";
import { Button, Icon, Text, useCardStyle, useColors } from "@poke/ui-native";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePoke } from "../../src/lib/poke";
import { serverId } from "../../src/lib/text";
import { Field } from "../../src/ui/Field";

/**
 * 21 Add an MCP server: paste its URL; Poke connects and lists what it found. A key, if the
 * server needs one, is a vault entry name: the header holds a placeholder, never the key.
 */
export default function AddMcpServer() {
  const { client } = usePoke();
  const c = useColors();
  const card = useCardStyle();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState("");
  const [vaultName, setVaultName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<McpServer>();

  const valid = /^https:\/\/[^\s]+$/.test(url.trim());
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const key = vaultName.trim().toLowerCase();
      const { server } = await client.addMcpServer({
        id: serverId(url.trim()),
        transport: {
          kind: "http",
          url: url.trim(),
          ...(key ? { headers: { Authorization: `Bearer {{vault:${key}.key}}` } } : {}),
        },
      });
      setAdded(server);
      void Haptics.notificationAsync(
        server.connected
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Warning,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.groundGrouped }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: 28, gap: 20, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ paddingHorizontal: 20, gap: 6 }}>
          <Text family="display" size="title1" lineHeight={34} accessibilityRole="header">
            Add an MCP server
          </Text>
          <Text size="subhead" color="ink2" lineHeight={21}>
            Give Poke tools from any server that speaks MCP.
          </Text>
        </View>
        <Field
          label="Server URL"
          value={url}
          onChangeText={(v) => {
            setUrl(v);
            setAdded(undefined);
          }}
          placeholder="https://mcp.example.com/mcp"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!added}
        />
        <Field
          label="Key from the vault (optional)"
          value={vaultName}
          onChangeText={setVaultName}
          placeholder="example.key"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!added}
          hint="If the server needs a key, save it in the Vault first, then name it here."
        />
        {error ? (
          <Text size="footnote" color="red" style={{ paddingHorizontal: 20 }}>
            {error}
          </Text>
        ) : null}
        {added ? (
          <View style={[card, { marginHorizontal: 16, borderRadius: 20, padding: 16, gap: 6 }]}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Icon name="server" size={18} color={c.ink} />
              <Text size="callout" weight="semibold" style={{ flex: 1 }}>
                {added.name}
              </Text>
            </View>
            <Text size="subhead" color={added.connected ? "ink2" : "red"}>
              {added.connected
                ? `Found ${added.toolCount ?? 0} tools`
                : (added.error ?? "Couldn't reach it yet. Poke keeps trying.")}
            </Text>
          </View>
        ) : null}
        <View style={{ marginHorizontal: 20, flexDirection: "row", gap: 10 }}>
          <Icon name="shield" size={16} color={c.ink3} />
          <Text size="footnote" color="ink3" lineHeight={18} style={{ flex: 1 }}>
            Poke uses these tools on his own, like any connected app. Only add servers you trust. You can
            remove it any time.
          </Text>
        </View>
      </ScrollView>
      <View style={{ padding: 16, paddingBottom: insets.bottom + 12 }}>
        {added ? (
          <Button tone="ink" width="fill" label="Done" onPress={() => router.back()} />
        ) : (
          <Button
            tone="ink"
            width="fill"
            label={busy ? "Connecting…" : "Add server"}
            disabled={!valid || busy}
            onPress={() => void add()}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
