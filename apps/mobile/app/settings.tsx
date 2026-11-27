import type { Device } from "@poke/client";
import { Button, Icon, ListGroup, ListRow, Text, useColors } from "@poke/ui-native";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePoke, useRemote } from "../src/lib/poke";
import { Screen } from "../src/ui/Screen";

const PLATFORM: Record<Device["platform"], string> = {
  ios: "iPhone",
  web: "Web",
  cli: "Terminal",
  shortcut: "Share Shortcut",
};
const ago = (ms?: number) => {
  if (!ms) return "Never seen";
  const min = Math.round((Date.now() - ms) / 60_000);
  if (min < 2) return "Active now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return new Date(ms).toLocaleDateString();
};

/** Settings: this phone's server, paired devices, the Share Shortcut, approvals and unpairing. */
export default function SettingsScreen() {
  const poke = usePoke();
  const { client, session } = poke;
  const health = useRemote((p) => p.client.health(), []);
  const devices = useRemote((p) => p.client.devices(), []);
  const voice = useRemote((p) => p.client.voice(), [], ["settings.updated"]);
  const [shareToken, setShareToken] = useState<string>();

  const revoke = (d: Device) =>
    Alert.alert(`Remove ${d.name}?`, "It won't be able to reach Poke anymore.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await client.removeDevice(d.id);
            void devices.reload();
          } catch (e) {
            Alert.alert("Couldn't remove it", e instanceof Error ? e.message : "");
          }
        },
      },
    ]);

  const unpair = () =>
    Alert.alert(
      "Unpair this iPhone?",
      "You'll need a new pairing code from your server to connect again. Poke and everything he knows stay on the server.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unpair",
          style: "destructive",
          onPress: async () => {
            await client.removeDevice(session.deviceId).catch(() => {});
            await poke.cache.clear();
            await poke.signOut();
          },
        },
      ],
    );

  const makeShareToken = async () => {
    try {
      const res = await client.shareToken();
      setShareToken(res.token);
      void devices.reload();
    } catch (e) {
      Alert.alert("Couldn't make a share key", e instanceof Error ? e.message : "");
    }
  };

  const voiceName = voice.data?.voices.find((v) => v.id === voice.data?.voice)?.name;
  const active = (devices.data?.devices ?? []).filter((d) => !d.revokedAt);
  return (
    <Screen title="Settings">
      <ListGroup header="Server">
        <ListRow
          tile="ink"
          title={session.url.replace(/^https?:\/\//, "")}
          subtitle={poke.status === "open" ? "Connected" : "Not connected right now"}
          icon={(color) => <Icon name="server" size={16} color={color} />}
          accessory="none"
        />
        {health.data ? (
          <ListRow tile="none" title="Poke on the server" value={health.data.version} accessory="none" />
        ) : null}
        <ListRow tile="none" title="This app" value={Constants.expoConfig?.version ?? "–"} accessory="none" />
      </ListGroup>

      <ListGroup header="Poke">
        <ListRow
          tile="orange"
          title="Voice"
          subtitle="How Poke sounds reading aloud and on calls"
          {...(voiceName ? { value: voiceName } : {})}
          icon={(color) => <Icon name="speaker" size={16} color={color} />}
          onPress={() => router.push("/voices")}
        />
        <ListRow
          tile="green"
          title="Always allowed"
          subtitle="Actions you told Poke he can do without asking"
          icon={(color) => <Icon name="shield" size={16} color={color} />}
          onPress={() => router.push("/approvals")}
        />
        <ListRow
          tile="blue"
          title="Share token"
          subtitle="For the Send to Poke shortcut: links, photos and files from any app"
          icon={(color) => <Icon name="share" size={16} color={color} />}
          onPress={() => void makeShareToken()}
        />
      </ListGroup>

      <ListGroup header="Devices">
        {active.map((d) => {
          const self = d.id === session.deviceId;
          return (
            <ListRow
              key={d.id}
              tile="none"
              title={self ? `${d.name} (this iPhone)` : d.name}
              subtitle={`${PLATFORM[d.platform]} · ${self ? "Active now" : ago(d.lastSeenAt)}`}
              accessory={self ? "none" : "chevron"}
              {...(self ? {} : { onPress: () => revoke(d) })}
            />
          );
        })}
        {devices.error && !devices.data ? (
          <ListRow
            tile="none"
            title="Couldn't load your devices"
            subtitle={`${devices.error}. Tap to try again.`}
            accessory="none"
            onPress={() => void devices.reload()}
          />
        ) : null}
      </ListGroup>

      <ListGroup>
        <ListRow tile="none" title="Unpair this iPhone" accessory="none" destructive onPress={unpair} />
      </ListGroup>
      {shareToken ? (
        <ShareSetup token={shareToken} url={session.url} onClose={() => setShareToken(undefined)} />
      ) : null}
    </Screen>
  );
}

/** Shows the share key once, with the steps for the iOS Shortcut (docs/SHARE_SHORTCUT.md). */
function ShareSetup({ token, url, onClose }: { token: string; url: string; onClose(): void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState<"key" | "url">();
  const copy = (what: "key" | "url", value: string) => {
    void Clipboard.setStringAsync(value);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(what);
  };
  const steps = [
    "In Shortcuts, make a new shortcut. In its details, turn on “Show in Share Sheet” and accept Text, URLs, Images, Files and PDFs.",
    "Add “Ask for Input” (Text) with the prompt “Add a note?”. You can leave it empty when you share.",
    "Add “Get Contents of URL”. Paste the address, set Method to POST, and add a header named Authorization with “Bearer ”, a space, then the key.",
    "Set Request Body to Form. Add a File field named “file” set to Shortcut Input, and a Text field named “note” set to Provided Input.",
    "Add “Get Dictionary Value” for “deepLink” from the result, then “Open URLs” with it, so Poke opens on what you shared.",
    "Name it “Send to Poke”. It now shows up in the share sheet of every app.",
  ];
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView
        style={{ backgroundColor: c.groundGrouped }}
        contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: insets.bottom + 24 }}
      >
        <Text family="display" size="title1" lineHeight={34}>
          Share to Poke
        </Text>
        <Text size="subhead" color="ink2" lineHeight={21}>
          This key can only send things to Poke. It can't read the thread. You'll see it once; you can always
          make a new one and remove the old one under Devices.
        </Text>
        <View style={{ gap: 10 }}>
          <Button
            tone="ink"
            width="fill"
            label={copied === "url" ? "Address copied" : "Copy the address"}
            onPress={() => copy("url", `${url.replace(/\/$/, "")}/v1/share`)}
          />
          <Button
            tone="fill"
            width="fill"
            label={copied === "key" ? "Key copied" : "Copy the key"}
            onPress={() => copy("key", token)}
          />
        </View>
        {steps.map((s, i) => (
          <View key={i} style={{ flexDirection: "row", gap: 12 }}>
            <Text size="callout" weight="semibold" color="ink3">
              {i + 1}
            </Text>
            <Text size="callout" lineHeight={22} style={{ flex: 1 }}>
              {s}
            </Text>
          </View>
        ))}
        <Button tone="plain" width="fill" label="Done" onPress={onClose} />
      </ScrollView>
    </Modal>
  );
}
