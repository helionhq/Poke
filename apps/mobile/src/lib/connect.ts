import type { PokeClient } from "@poke/client";
import * as WebBrowser from "expo-web-browser";
import { Alert } from "react-native";

/**
 * Starts an app's sign-in (Executor's page) in an in-app browser. Poke notices when it finishes
 * and the app list updates by itself (integration.updated).
 */
export async function connectApp(client: PokeClient, appId: string): Promise<void> {
  try {
    const { url } = await client.connect(appId);
    await WebBrowser.openAuthSessionAsync(url, "poke://apps");
  } catch (e) {
    Alert.alert("Couldn't start connecting", e instanceof Error ? e.message : "");
  }
}
