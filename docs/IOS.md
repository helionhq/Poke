# iOS

_Filled in during milestones 9 and 11. See the brief, sections 3.1, 20 and 23._

## Vault and Face ID (server side done in milestone 5)

The server checks Face ID itself (decision 41), so the app has to:

1. At pairing, make an Ed25519 key pair, store the private key with `expo-secure-store` and
   `requireAuthentication: true` (reading it needs Face ID), and send the public key as
   `vaultKey` (raw 32 bytes, base64url) in `POST /v1/pair`.
2. For each vault action, call `POST /v1/vault/challenge {action, name?}`, read the private key
   (the Face ID prompt), sign the returned `message` (UTF-8) with Ed25519, and send
   `X-Poke-Vault-Proof: <challengeId>.<signature base64url>` with the request.

To verify in milestone 9: that keys stored with `requireAuthentication` survive SideStore
refreshes, and which pure-JS Ed25519 library signs fast enough on the phone.
