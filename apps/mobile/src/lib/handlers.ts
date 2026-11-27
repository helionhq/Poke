import { newClientMessageId, type Block, type PokeClient } from "@poke/client";
import type { BlockHandlers, MarkRef, MarkResolver } from "@poke/ui-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import * as WebBrowser from "expo-web-browser";
import { Alert } from "react-native";
import type { Poke } from "./poke";

/** Well-known app ids → the site whose logo stands for them (through Poke's logo proxy). */
const APP_DOMAINS: Record<string, string> = {
  gmail: "mail.google.com",
  "google-calendar": "calendar.google.com",
  googlecalendar: "calendar.google.com",
  "google-drive": "drive.google.com",
  googledrive: "drive.google.com",
  "google-maps": "maps.google.com",
  slack: "slack.com",
  notion: "notion.so",
  github: "github.com",
  linear: "linear.app",
  spotify: "spotify.com",
  resy: "resy.com",
  airbnb: "airbnb.com",
  strava: "strava.com",
  stripe: "stripe.com",
  figma: "figma.com",
  dropbox: "dropbox.com",
  outlook: "outlook.com",
  todoist: "todoist.com",
  whatsapp: "whatsapp.com",
};

export function markResolver(client: PokeClient): MarkResolver {
  const headers = client.authHeaders();
  return (mark: MarkRef) => {
    if (mark.icon && /^https:\/\//.test(mark.icon)) return { uri: client.imageUrl(mark.icon), headers };
    const app = mark.app?.toLowerCase().replace(/-(work|personal|\d+)$/, "");
    const domain = mark.domain ?? (app ? APP_DOMAINS[app] : undefined);
    return domain ? { uri: client.logoUrl(domain), headers } : undefined;
  };
}

/** What blocks in the thread can do: every action goes to the server, with a haptic. */
export function blockHandlers(
  poke: Poke,
  ui: {
    writeOwn?: (block: Block) => void;
    /** A card outside the thread changed (a side chat's). */ onBlock?: (block: Block) => void;
  } = {},
): BlockHandlers {
  const { client, store } = poke;
  const headers = client.authHeaders();
  return {
    async act(block, action, payload) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        const res = await client.act(block.id, {
          action,
          ...(payload ? { payload } : {}),
          clientActionId: newClientMessageId(),
        });
        if (res.block.scope === "main") store.putBlock(res.block);
        else ui.onBlock?.(res.block);
        const url = typeof res.result?.url === "string" ? res.result.url : undefined;
        if (url) {
          // The sign-in page; the block turns "connected" by itself when it finishes.
          await WebBrowser.openAuthSessionAsync(url, "poke://thread");
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const message = error instanceof Error ? error.message : "That didn't go through";
        // The secret field shows its own error; everything else gets an alert.
        if (block.kind !== "secret_request") Alert.alert("Couldn't do that", message);
        throw error;
      }
    },
    writeOwn: ui.writeOwn,
    copy(text) {
      void Clipboard.setStringAsync(text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    async paste() {
      return (await Clipboard.getStringAsync()) || undefined;
    },
    openLink(url) {
      if (/^https?:\/\//.test(url)) void WebBrowser.openBrowserAsync(url);
    },
    imageSource(src) {
      return { uri: client.imageUrl(src), headers };
    },
  };
}
