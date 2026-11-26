import { AgentMark, Button, Grain, Text, Wallpaper, useColors } from "@poke/ui-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { pair, parsePairing } from "../src/lib/pairing";
import { useSignIn } from "../src/lib/poke";

/**
 * Pairing (new screen): scan the QR that `poke config devices pair` shows on the server, or paste its link.
 * Makes the Face ID vault key on the way.
 */
export default function PairScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const signIn = useSignIn();
  const params = useLocalSearchParams<{ d?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const seen = useRef<string>(undefined);

  const submit = async (raw: string) => {
    if (busy || raw === seen.current) return;
    seen.current = raw;
    const code = parsePairing(raw);
    if (!code) {
      setError(
        "That isn't a Poke pairing code. On your server, run “poke config devices pair” and scan the code it shows.",
      );
      return;
    }
    setBusy(true);
    setScanning(false);
    setError(undefined);
    try {
      const session = await pair(code);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      signIn(session);
    } catch (e) {
      seen.current = undefined;
      setError(e instanceof Error ? e.message : "Pairing didn't work. Try a fresh code.");
    } finally {
      setBusy(false);
    }
  };

  // poke://pair?d=… opened from the Camera app.
  useEffect(() => {
    if (params.d) void submit(`poke://pair?d=${params.d}`);
  }, [params.d]);

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <Wallpaper scene="dunes" />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: insets.top + 64,
            paddingBottom: insets.bottom + 24,
            paddingHorizontal: 24,
            gap: 28,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ alignItems: "center", gap: 14 }}>
            <AgentMark size="xl" state={busy ? "active" : "idle"} />
            <Text family="display" size="largeTitle" lineHeight={40} align="center">
              Poke
            </Text>
            <Text size="callout" color="ink2" align="center" lineHeight={22}>
              Connect this iPhone to your Poke server. On the server, run{" "}
              <Text family="mono" size="subhead">
                poke config devices pair
              </Text>{" "}
              and scan the code it shows.
            </Text>
          </View>
          {scanning && permission?.granted ? (
            <View style={{ height: 300, borderRadius: 26, overflow: "hidden", backgroundColor: c.black }}>
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => void submit(data)}
              />
            </View>
          ) : null}
          <View style={{ gap: 12 }}>
            {busy ? (
              <View
                style={{
                  flexDirection: "row",
                  gap: 10,
                  justifyContent: "center",
                  alignItems: "center",
                  height: 48,
                }}
              >
                <ActivityIndicator color={c.ink2} />
                <Text size="callout" color="ink2">
                  Pairing…
                </Text>
              </View>
            ) : (
              <Button
                tone="ink"
                width="fill"
                label={scanning ? "Stop scanning" : "Scan the pairing code"}
                onPress={async () => {
                  if (scanning) return setScanning(false);
                  const granted = permission?.granted || (await requestPermission()).granted;
                  if (granted) {
                    seen.current = undefined;
                    setScanning(true);
                  } else setError("Poke needs the camera to scan the code. You can paste the link instead.");
                }}
              />
            )}
            <TextInput
              value={typed}
              onChangeText={setTyped}
              placeholder="Or paste the pairing link"
              placeholderTextColor={c.ink3}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => void submit(typed)}
              returnKeyType="go"
              editable={!busy}
              accessibilityLabel="Pairing link"
              style={{
                height: 48,
                paddingHorizontal: 16,
                borderRadius: 13,
                backgroundColor: c.card,
                borderWidth: 1,
                borderColor: c.separator,
                color: c.ink,
                fontFamily: "OpenRunde-Regular",
                fontSize: 16,
              }}
            />
            {typed.trim() ? (
              <Button
                tone="fill"
                width="fill"
                label="Pair"
                onPress={() => void submit(typed)}
                disabled={busy}
              />
            ) : null}
            {error ? (
              <Text size="footnote" color="red" align="center" lineHeight={18}>
                {error}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <Grain />
    </View>
  );
}
