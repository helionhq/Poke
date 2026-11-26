import * as SecureStore from "expo-secure-store";

/** Where Poke lives and how this phone signs in. Kept in the Keychain, this device only. */
export interface Session {
  url: string;
  token: string;
  deviceId: string;
  /** Cloudflare Access service-token headers from the pairing code, if the server sits behind Access. */
  headers?: Record<string, string>;
}

const KEY = "poke.session.v1";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export async function loadSession(): Promise<Session | undefined> {
  const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Session;
    return parsed.url && parsed.token ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(session), OPTIONS);
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}
