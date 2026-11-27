import { AgentMark, Glass, Grain, Icon, IconButton, Text, Wallpaper, useColors } from "@poke/ui-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePoke, useRemote } from "../src/lib/poke";
import { Call, type CallView } from "../src/lib/voice";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
/** How often a camera still goes up while the camera is on (the newest rides with his next turn). */
const FRAME_MS = 2500;

const STATUS: Record<CallView["state"], string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
};

/**
 * 07 Voice: a hands-free call with Poke on the haze wallpaper. What he last said is small above;
 * Poke's reply is large and serif, filling in as it's spoken. Everything said lands in the thread.
 */
export default function VoiceScreen() {
  const poke = usePoke();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const info = useRemote((p) => p.client.voice(), [], []);
  const [view, setView] = useState<CallView>({
    state: "connecting",
    user: "",
    poke: "",
    level: 0,
    muted: false,
  });
  const [seconds, setSeconds] = useState(0);
  const [cameraOn, setCameraOn] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const call = useRef<Call>(undefined);
  const camera = useRef<CameraView>(null);

  const configured = info.data?.configured;
  useEffect(() => {
    if (!configured) return;
    const session = new Call(poke.client, setView);
    call.current = session;
    void session.start();
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    // The call ends when the app leaves the screen; iOS would cut the mic anyway.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") void session.end();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
      void session.end();
    };
  }, [configured, poke.client]);

  // Camera stills while the camera is on.
  useEffect(() => {
    if (!cameraOn) return;
    const timer = setInterval(() => {
      void camera.current
        ?.takePictureAsync({ quality: 0.35, base64: true, shutterSound: false })
        .then((photo) => {
          if (photo?.base64) call.current?.frame(photo.base64);
        })
        .catch(() => {});
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [cameraOn]);

  const toggleCamera = async () => {
    if (cameraOn) {
      setCameraOn(false);
      call.current?.cameraOff();
      return;
    }
    if (!permission?.granted && !(await requestPermission()).granted) return;
    setCameraOn(true);
  };

  const end = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void call.current?.end();
    router.back();
  };

  const unavailable = info.data && !info.data.configured;
  const live = view.state !== "ended" && !unavailable;

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
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: live && view.state !== "connecting" ? c.green : c.ink3,
                }}
              />
              <Text size="footnote" weight="semibold">
                {unavailable ? "Voice isn't set up" : `Talking with Poke ${mmss(seconds)}`}
              </Text>
            </View>
          </Glass>
        </View>
        {cameraOn ? (
          <View
            style={{
              position: "absolute",
              top: insets.top + 60,
              right: 20,
              width: 108,
              height: 144,
              borderRadius: 18,
              overflow: "hidden",
              borderCurve: "continuous",
            }}
          >
            <CameraView ref={camera} style={{ flex: 1 }} facing="back" animateShutter={false} />
          </View>
        ) : null}
        <View style={{ flex: 1, justifyContent: "center", gap: 20 }}>
          <AgentMark
            size="xl"
            state={view.state === "thinking" || view.state === "speaking" ? "active" : "idle"}
          />
          {unavailable ? (
            <>
              <Text size="subhead" color="ink2">
                Voice calls need an AssemblyAI key on your server.
              </Text>
              <Text family="serif" size="title1" lineHeight={36}>
                Add one with “poke config” on the server, then call me again.
              </Text>
            </>
          ) : (
            <>
              <Text size="subhead" color="ink2" numberOfLines={3}>
                {view.error ?? (view.user || STATUS[view.state])}
              </Text>
              <Text family="serif" size="title1" lineHeight={36} numberOfLines={9}>
                {view.poke || (view.state === "listening" && !view.user ? "I'm listening." : "")}
              </Text>
            </>
          )}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Glass dense style={{ borderRadius: 999 }}>
            <View
              accessibilityLabel={STATUS[view.state]}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 18,
                height: 56,
              }}
            >
              <Waveform level={view.muted ? 0 : view.state === "speaking" ? 0.5 : view.level} />
            </View>
          </Glass>
          <View style={{ flexDirection: "row", gap: 12 }}>
            <IconButton
              size="large"
              accessibilityLabel={view.muted ? "Unmute" : "Mute"}
              disabled={!live}
              onPress={() => call.current?.mute(!view.muted)}
              icon={(color) => <Icon name="mic" size={22} color={view.muted ? c.red : color} />}
            />
            <IconButton
              size="large"
              accessibilityLabel={cameraOn ? "Turn the camera off" : "Show Poke with the camera"}
              disabled={!live}
              onPress={() => void toggleCamera()}
              icon={(color) => <Icon name="camera" size={22} color={cameraOn ? c.sky : color} />}
            />
            <IconButton
              size="large"
              tone="danger"
              accessibilityLabel="End call"
              onPress={end}
              icon={(color) => <Icon name="phoneDown" size={24} color={color} />}
            />
          </View>
        </View>
      </View>
      <Grain />
    </View>
  );
}

/** Five bars that rise with the loudness. */
function Waveform({ level }: { level: number }) {
  const c = useColors();
  const shape = [0.45, 0.8, 1, 0.7, 0.4];
  return (
    <>
      {shape.map((s, i) => (
        <View
          key={i}
          style={{
            width: 3,
            borderRadius: 2,
            height: 6 + Math.round(18 * s * Math.max(0.15, level)),
            backgroundColor: level > 0 ? c.ink : c.ink3,
          }}
        />
      ))}
    </>
  );
}
