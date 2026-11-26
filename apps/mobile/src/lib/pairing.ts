import { PokeClient } from "@poke/client";
import * as Device from "expo-device";
import { fromBase64Url, fromUtf8 } from "./base64";
import { saveSession, type Session } from "./session";
import { createVaultKey } from "./vaultKey";

/** What the pairing QR holds (`poke://pair?d=<base64url JSON>`), see contracts PairingPayload. */
export interface PairingCode {
  url: string;
  code: string;
  access?: { clientId: string; clientSecret: string };
}

/**
 * Accepts the QR's deep link, its `d=` payload, or a typed "https://poke.example.com 123-456".
 * Returns undefined when it isn't a pairing code.
 */
export function parsePairing(input: string): PairingCode | undefined {
  const text = input.trim();
  const d =
    /[?&]d=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(text) ? text : undefined);
  if (d) {
    try {
      const json = JSON.parse(fromUtf8(fromBase64Url(d))) as {
        v?: number;
        url?: string;
        code?: string;
        access?: PairingCode["access"];
      };
      if (
        json.v === 1 &&
        typeof json.url === "string" &&
        /^https?:\/\//.test(json.url) &&
        typeof json.code === "string"
      )
        return {
          url: json.url.replace(/\/+$/, ""),
          code: json.code,
          ...(json.access ? { access: json.access } : {}),
        };
    } catch {
      return undefined;
    }
    return undefined;
  }
  const typed = /^(https?:\/\/\S+)\s+([A-Za-z0-9-]{4,64})$/.exec(text);
  return typed ? { url: typed[1]!.replace(/\/+$/, ""), code: typed[2]! } : undefined;
}

export function accessHeaders(access?: PairingCode["access"]): Record<string, string> | undefined {
  return access
    ? { "CF-Access-Client-Id": access.clientId, "CF-Access-Client-Secret": access.clientSecret }
    : undefined;
}

/** Pairs this phone: makes the vault key, trades the code for a device token, saves the session. */
export async function pair(code: PairingCode): Promise<Session> {
  const headers = accessHeaders(code.access);
  const client = new PokeClient({ baseUrl: code.url, ...(headers ? { headers } : {}) });
  await client.health();
  const vaultKey = await createVaultKey();
  const { token, device } = await client.pair({
    code: code.code,
    deviceName: Device.deviceName ?? "iPhone",
    platform: "ios",
    ...(vaultKey ? { vaultKey } : {}),
  });
  const session: Session = { url: code.url, token, deviceId: device.id, ...(headers ? { headers } : {}) };
  await saveSession(session);
  return session;
}
