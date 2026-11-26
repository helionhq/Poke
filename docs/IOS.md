# iOS

The app is `apps/mobile`: Expo SDK 58 (React Native 0.88, React 19.3), expo-router, Hermes. It is
built from the Doop canvas's tokens and components (`@poke/ui-tokens`, `@poke/ui-native`) and talks
to the server only through `@poke/client`. Live Activity, OTA updates and the release pipeline are
milestone 11 (brief §23); voice is milestone 10.

## Layout

```
apps/mobile/
  app/                      expo-router screens (file name = route = deep link)
    _layout.tsx             fonts, theme, PokeProvider, MarkProvider, Stack with guards
    pair.tsx                pairing: scan the QR or paste the link (poke://pair?d=…)
    index.tsx               01 Thread (+ 02 working, 03 selection, 05 add menu, blocks 10–24)
    thread.tsx              poke://thread?message=… → the thread, scrolled to it
    search.tsx              04 Search the thread
    agent.tsx               06 Agent sheet (form sheet)
    voice.tsx               07 Voice (layout; audio in milestone 10)
    sidechat.tsx            09 Side chat
    routines/index, [id]    12 Routines, one routine (poke://routines/:id)
    skills/index, [name]    13 Skills, one skill
    vault.tsx               15 Vault (poke://vault)
    apps/index, [id], mcp   19 Connect an app, 20 an app's accounts, 21 Add an MCP server
    library.tsx             Library (brief §16): attachments and the workspace
    settings.tsx            server, devices, share token, unpair
    approvals.tsx           "Always allowed" rules
  src/lib/                  session, pairing, vault key, cache, PokeProvider, handlers
  src/thread/               message rows, traces, menus
  src/ui/                   Screen frame, Field
  modules/document-scanner  local Expo module: VisionKit document camera → one PDF
```

Packages:

- `@poke/ui-tokens`: colours (light and dark), type scale, radii, fonts, wallpapers, the mark.
- `@poke/ui-native`: the Doop components in React Native (NavBar, Composer, ListRow, Trace, every
  block). Source-only, extensionless imports for Metro. It never imports the client or the domain.
- `@poke/client`: REST, the resumable event stream, the outbox and the thread store. Plain
  TypeScript, also used by tests and later by the web app.

## Data flow

`PokeProvider` (src/lib/poke.tsx) owns one `PokeClient`, one `ThreadStore` ("main"), one `Outbox`
and one `EventStream` per paired session.

1. **Launch:** the session (server URL, device token, Cloudflare Access headers) comes from
   SecureStore. The thread is restored from the SQLite cache (the last 300 messages, their blocks
   and traces, and the last event seq) and drawn straight away.
2. **Stream:** `/v1/events?since=<seq>` replays what was missed, then streams. A `hello` with
   `reset` (too far behind) refetches the newest page. Presence (foreground or background) rides
   on the socket, so the server knows whether to push.
3. **Sending:** a message goes into the outbox first (persisted in the cache) and is drawn as a
   pending bubble. The outbox sends with a `clientMessageId`; the server's copy replaces the
   pending one when it arrives on the stream. Offline, 5xx and 429 retry; any other error marks it
   failed with Retry and Delete.
4. **Saving:** the store is written to the cache 0.8 s after changes settle and when the app goes
   to the background.
5. **Other events** (routines, skills, vault, integrations, side chats) go to screens through
   `onEvent`, and `useRemote` reloads a screen's data when its events arrive.

## Images and logos

The phone never loads third-party images. Card images go through `GET /v1/images?src=` and app
logos through `GET /v1/logos/:domain`, both with the device token (`MarkProvider` resolves a
block's `{app, domain, icon}` to one of those). Attachments load from `/v1/attachments/:id`.

## Vault and Face ID

The server checks Face ID itself (decision 41):

1. At pairing, the app makes an Ed25519 key pair (`@noble/ed25519`, random bytes from
   `expo-crypto`), stores the private key with `expo-secure-store` and `requireAuthentication`
   (reading it needs Face ID, `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`), and sends the public key as
   `vaultKey` in `POST /v1/pair`.
2. Each vault action asks for a challenge (`POST /v1/vault/challenge {action, name?}`), reads the
   key (the Face ID prompt), signs the message and sends `X-Poke-Vault-Proof`.

The Vault screen keeps entries in memory only, clears them when the app goes to the background,
and hides a revealed secret again after 30 seconds. Nothing from the vault is cached on the phone.

## Deep links

`poke://thread?message=<id>`, `poke://vault`, `poke://routines/<id>`, `poke://pair?d=<payload>`.
Every screen except pairing sits behind `Stack.Protected`, so a link opened before pairing lands on
the pairing screen.

## Share to Poke

A Shortcut, not an extension: see [SHARE_SHORTCUT.md](SHARE_SHORTCUT.md). Settings makes the
share token.

## Checks

- `pnpm --filter @poke/mobile typecheck` and `test` (Jest, `jest-expo/ios`, Testing Library 14:
  `render` and `fireEvent` are async).
- `pnpm --filter @poke/mobile exec expo export --platform ios` bundles the app (CI runs it).
- Build `@poke/contracts`, `@poke/blocks`, `@poke/client` and `@poke/ui-tokens` first: Metro and
  Jest load their `dist`.

## To verify on a phone

These need a Mac build and an iPhone; none can run on the Windows dev box or in CI:

- SecureStore keys with `requireAuthentication` survive SideStore's weekly refresh (if not, the
  app shows "This phone has no vault key" and pairing again makes a new one).
- Ed25519 signing time on the A15 (noble is pure JS; expected well under 50 ms).
- The VisionKit scanner module builds and returns a PDF (`modules/document-scanner`).
- Liquid Glass on iOS 26 and the blur fallback below it.
- The Shortcut steps in SHARE_SHORTCUT.md.
