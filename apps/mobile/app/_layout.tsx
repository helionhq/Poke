import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";
import { fontFiles, MarkProvider, ThemeProvider, useColors } from "@poke/ui-native";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { markResolver } from "../src/lib/handlers";
import { PokeProvider, usePokeState } from "../src/lib/poke";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ ...fontFiles, JetBrainsMono_400Regular });
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <PokeProvider>{fontsLoaded ? <Navigator /> : null}</PokeProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Navigator() {
  const state = usePokeState();
  const c = useColors();
  useEffect(() => {
    if (state.phase !== "loading") void SplashScreen.hideAsync();
  }, [state.phase]);
  const resolve = useMemo(
    () => (state.phase === "ready" ? markResolver(state.poke.client) : () => undefined),
    [state],
  );
  if (state.phase === "loading") return null;
  const paired = state.phase === "ready";
  return (
    <MarkProvider resolve={resolve}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.groundGrouped } }}>
        <Stack.Protected guard={!paired}>
          <Stack.Screen name="pair" />
        </Stack.Protected>
        <Stack.Protected guard={paired}>
          <Stack.Screen name="index" options={{ contentStyle: { backgroundColor: c.ground } }} />
          <Stack.Screen name="thread" />
          <Stack.Screen name="search" options={{ animation: "fade" }} />
          <Stack.Screen
            name="agent"
            options={{
              presentation: "formSheet",
              sheetAllowedDetents: [0.92],
              sheetGrabberVisible: true,
              sheetCornerRadius: 38,
            }}
          />
          <Stack.Screen name="sidechat" options={{ presentation: "fullScreenModal" }} />
          <Stack.Screen name="voice" options={{ presentation: "fullScreenModal", animation: "fade" }} />
          <Stack.Screen
            name="apps/mcp"
            options={{
              presentation: "formSheet",
              sheetAllowedDetents: [0.92],
              sheetGrabberVisible: true,
              sheetCornerRadius: 38,
            }}
          />
          <Stack.Screen name="apps/index" />
          <Stack.Screen name="apps/[id]" />
          <Stack.Screen name="routines/index" />
          <Stack.Screen name="routines/[id]" />
          <Stack.Screen name="skills/index" />
          <Stack.Screen name="skills/[name]" />
          <Stack.Screen name="vault" />
          <Stack.Screen name="library" />
          <Stack.Screen name="settings" />
          <Stack.Screen name="voices" />
          <Stack.Screen name="approvals" />
        </Stack.Protected>
      </Stack>
    </MarkProvider>
  );
}
