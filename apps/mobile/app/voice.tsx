import { AgentMark, Glass, Grain, Icon, IconButton, Text, Wallpaper, useColors } from "@poke/ui-native";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * 07 Voice: a hands-free call with Poke on the haze wallpaper. His reply is large and serif;
 * what you last said is small above it. The audio pipeline arrives with voice (milestone 10).
 */
export default function VoiceScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <Wallpaper scene="haze" />
      <View
        style={{
          flex: 1,
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 20,
          paddingHorizontal: 24,
        }}
      >
        <View style={{ alignItems: "center" }}>
          <Glass dense style={{ borderRadius: 999 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 14,
                height: 34,
              }}
            >
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.green }} />
              <Text size="footnote" weight="semibold">
                Talking with Poke {mmss(seconds)}
              </Text>
            </View>
          </Glass>
        </View>
        <View style={{ flex: 1, justifyContent: "center", gap: 20 }}>
          <AgentMark size="xl" state="active" />
          <Text size="subhead" color="ink2">
            Voice calls aren't set up on your server yet.
          </Text>
          <Text family="serif" size="title1" lineHeight={36}>
            When they are, you'll hear me here, and everything we say lands in the thread afterwards.
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Glass dense style={{ borderRadius: 999 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingHorizontal: 16,
                height: 56,
              }}
            >
              <Icon name="waveform" size={22} color={muted ? c.ink3 : c.ink} />
            </View>
          </Glass>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <IconButton
              size="large"
              accessibilityLabel={muted ? "Unmute" : "Mute"}
              onPress={() => setMuted(!muted)}
              icon={(color) => <Icon name="mic" size={22} color={muted ? c.red : color} />}
            />
            <IconButton
              size="large"
              accessibilityLabel="Camera"
              disabled
              icon={(color) => <Icon name="camera" size={22} color={color} />}
            />
            <IconButton
              size="large"
              tone="danger"
              accessibilityLabel="End call"
              onPress={() => router.back()}
              icon={(color) => <Icon name="phoneDown" size={24} color={color} />}
            />
          </View>
        </View>
      </View>
      <Grain />
    </View>
  );
}
