import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import type { PokeClient, VaultAction } from "@poke/client";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { fromBase64Url, toBase64Url, utf8 } from "./base64";

// noble needs a synchronous SHA-512 (Hermes has no WebCrypto subtle).
ed.hashes.sha512 = sha512;

/**
 * The vault key (docs/IOS.md): an Ed25519 key made at pairing. The private half sits in the
 * Keychain behind Face ID (`requireAuthentication`), so every read is a Face ID prompt; the
 * server checks a signature over its one-time challenge before any vault call.
 */
const KEY = "poke.vaultKey.v1";
const PROTECTED: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  authenticationPrompt: "Unlock your Vault",
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};

/** Makes a new key pair, stores the private key, returns the public key (base64url). */
export async function createVaultKey(): Promise<string | undefined> {
  if (!SecureStore.canUseBiometricAuthentication()) return undefined;
  const secret = Crypto.getRandomBytes(32);
  const publicKey = ed.getPublicKey(secret);
  await SecureStore.setItemAsync(KEY, toBase64Url(secret), PROTECTED);
  secret.fill(0);
  return toBase64Url(publicKey);
}

export async function deleteVaultKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, PROTECTED);
}

/** Signs a challenge message (UTF-8) with a secret key. Exported for tests. */
export function signMessage(secret: Uint8Array, message: string): string {
  return toBase64Url(ed.sign(utf8(message), secret));
}

/**
 * One vault call's proof: a fresh challenge, Face ID (reading the key), a signature.
 * Throws "cancelled" when he dismisses Face ID.
 */
export async function vaultProof(client: PokeClient, action: VaultAction, name?: string): Promise<string> {
  const challenge = await client.vaultChallenge(action, name);
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(KEY, PROTECTED);
  } catch {
    throw new VaultLocked("cancelled");
  }
  if (!stored) throw new VaultLocked("missing");
  const secret = fromBase64Url(stored);
  try {
    return `${challenge.challengeId}.${signMessage(secret, challenge.message)}`;
  } finally {
    secret.fill(0);
  }
}

export class VaultLocked extends Error {
  constructor(readonly reason: "cancelled" | "missing") {
    super(
      reason === "cancelled"
        ? "Face ID didn't go through"
        : "This phone has no vault key. Pair it again from Settings to use the Vault.",
    );
  }
}
