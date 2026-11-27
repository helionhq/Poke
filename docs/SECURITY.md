# Security

_The vault, redaction and approvals sections are filled in during milestone 5. See the brief,
sections 3.9, 10 and 12._

## Network surface

- poke-server listens on `127.0.0.1:7070` only. It is reachable from outside through the Cloudflare
  Tunnel (`poke.arham.im`), never on a LAN or public interface.
- The admin API is a unix socket (`~/poke/run/admin.sock`, mode 0600) and does not exist on the
  TCP listener. Anyone who can open it is Poke's own user, which already owns `~/poke`.

## Devices

- Pairing codes are single use, expire after 10 minutes and are stored as sha256 hashes. After ten
  wrong codes in ten minutes, pairing is locked for the rest of the window.
- Device tokens are 32 random bytes (`pk_…`), shown once, stored only as sha256 hashes and looked up
  by hash (the raw token is never stored). Revoking a device invalidates its token
  immediately.
- Share tokens (for the iOS "Share to Poke" Shortcut) can only call `POST /v1/share`.
- The WebSocket bearer subprotocol is never echoed back in the handshake response.
- API responses never include token hashes.

## Files

- Attachments are written under `~/poke/library/attachments/YYYY/MM/` with sanitized names; the file
  store refuses paths that escape its root.
- The vault master key is created by `poke setup` at `~/poke/keys/master.key` (mode 0600). Under
  systemd, `LoadCredential=` can supply it instead (`$CREDENTIALS_DIRECTORY/master.key`).

## Model credentials (milestone 3)

- Every provider credential (`poke login`) lives in the vault's system namespace (`~/poke/data/vault.db`,
  XChaCha20-Poly1305 under the master key), never in `poke.db`, config files, git or the
  environment. pi-ai gets keys per request from a read-only credential store; it is never allowed
  to read env vars.
- The CLI never takes a secret as a command-line argument (it would land in shell history and
  `ps`): it prompts with a hidden input, or reads `--stdin`. Each credential is validated before
  it is saved.
- **The Claude subscription serves only the Poke and Side chat roles.** The model registry refuses it
  for any other role, and the Claude runtime refuses to open any other session. Executors, memory and
  the model gateway can't reach it.
- Claude Code runs with an environment built from an allowlist (PATH, HOME, locale, temp dirs) plus
  `CLAUDE_CODE_OAUTH_TOKEN` and Poke's own `CLAUDE_CONFIG_DIR`. Anything starting with
  `ANTHROPIC_`, `CLAUDE_CODE_USE_`, `AWS_`, `GOOGLE_`, `AZURE_`, `OPENAI_`, `VOYAGE_`,
  `DASHSCOPE_` or `QWEN_` is never passed, so an `ANTHROPIC_API_KEY` can't switch it to API
  billing. `settingSources: []` keeps user and project settings, hooks and CLAUDE.md files out;
  `--bare` is never used.

## Redaction (milestone 3)

Every tool result of every agent passes through the gateway's redactor before a model, the
transcript, a log or a notification sees it. The redaction set is every vault secret (system
credentials and entry secret fields), refreshed when the vault changes. Each value is matched raw and
as base64, base64url, URL-encoded and JSON-escaped text, longest first. Compaction summaries are
redacted before they are stored.


## Blocks (milestone 4)

- A value typed into a `secret_request` goes from the app to `POST /v1/blocks/:id/actions` and
  straight into the vault. It is never stored in a block, a message, the event log or the action
  log (which keeps the result, never the payload), never logged (request bodies aren't), and never
  echoed: an invalid secret payload only says "That value can't be saved". The agent gets
  `{status: "saved", vaultName, placeholder}`. Once saved, the value joins the redaction set.
- One-time codes are saved as ephemeral vault entries that expire after 10 minutes.
- Authority is server-side. The app sends an action name and a payload; the server checks the kind,
  that a user may send that action (`expire`, `connected` and `failed` are server-only), the current
  state, and the payload schema. A card press can only name a button the stored card has, and only
  its own field keys are passed on.
- Cards are data, not code: a fixed set of primitives, https images only (to be loaded through the
  server by the image proxy that comes with the app in milestone 9, with private addresses refused),
  logos by app id or domain, links opened only on a tap, with limits on size and depth.
- Actions are idempotent per `clientActionId` and serialised per block, so a retried or doubled tap
  can't save, book or approve twice.

## Vault use without seeing (milestone 5)

- Agents write `{{vault:name.field}}`. The `SecretResolver` fills values in **inside the tool
  executor**, after the model emitted the call: for Pi's `write` and `edit`, for any gateway tool
  registered with `resolveSecrets` (Executor calls, the browser and HTTP tools in milestone 6), and
  for `bash` as per-call environment variables (`"${POKE_SECRET_RESY_LOGIN_PASSWORD}"`), so the
  value never appears on a command line. Transcripts keep the placeholders. Tools that pass text on
  to a model (`send_to_agent`, `ask_poke`) never resolve them.
- An unknown entry, a missing field, or a used-up one-time code fails the call with a message the
  agent can act on; nothing runs with a half-filled argument.
- After the tool runs, the entry is marked used ("Used by" the integration). One-time codes are
  deleted on first use; a sweep every minute wipes any older than 10 minutes.
- Redaction now leaves `[vault:<entry>]` (or `[vault:system]` for provider credentials) in
  place of every form of a secret.

## Face ID for the vault (milestone 5)

- At pairing the phone makes an Ed25519 key pair, keeps the private key in the Keychain behind Face
  ID, and sends the public key (`vaultKey`). The server stores only the public key.
- Every vault request (list, add, edit, delete, reveal) needs a fresh proof:
  `POST /v1/vault/challenge {action, name?}` returns a challenge (60 s, single use, bound to the
  device and to that action on that entry); the phone signs it after Face ID and sends
  `X-Poke-Vault-Proof: <challengeId>.<signature>`. A stolen device token can't open the vault, and
  a proof can't be replayed or reused for another entry. Five failed proofs lock the device out of
  the vault for five minutes.
- The admin socket and agents can't reach these routes. Reveal answers with
  `Cache-Control: no-store`. Provider credentials are never listed.
- A device paired without a key (the CLI, an older phone) can't open the vault; pairing again from
  the app enrols one.

## Approvals (milestone 5)

- Poke gates nothing on its own (brief 12). Only a call Executor pauses goes through
  `ApprovalService.gate`: an always-allow rule that matches lets it run; otherwise the agent parks,
  and the decision comes only from the stored approval's block. The client never sends the call's
  details back; the server decides against what it stored.
- Always-allow rules exist only for Executor-gated tools and are created only from the "Always
  allow …" option of a real approval. Their conditions are a small JSON-logic subset over the
  arguments; a condition that can't be read never allows anything.
- Every decision (allowed, denied, by rule, expired) is logged with a sha256 of the arguments (keys
  sorted). Arguments kept for display are redacted first. An approval whose agent stops waiting
  expires, and so does its block.

## Integrations (milestone 6)

- **Executor always runs in model mode.** The bridge connects to
  `https://mcp.executor.sh/org/<org>/mcp?elicitation_mode=model`; with a token on the plain URL
  Executor would approve gated calls by itself. A gated call comes back as `approval-required` and
  goes through `ApprovalService.gate` like every other OK.
- **Agents can't approve their own calls.** `executor_resume` only accepts input requests
  (`elc_…`); approval ids (`apr_…`) are refused. Only the stored approval's block resumes the call,
  and the bridge accepts or declines on Executor's side itself.
- An edited draft can't be passed through Executor's resume (approvals accept no content), so the
  original call is declined and the agent sends the edited text again. That one new call goes
  through without a second OK only if it carries every edited value, for the same task and tool,
  within 10 minutes; the decision is logged like any other.
- The Executor token and Keenable key live in the vault's system namespace. The CLI never takes them
  as arguments: `poke config executor.token` prompts, or reads `--stdin`. The Keenable SDK is given
  an explicit (possibly empty) key and base URL so it never reads environment variables.
- **Local MCP servers** get placeholders, not secrets: headers and env hold
  `{{vault:name.field}}`, filled in only when the server is started, and stored as placeholders.
  Stdio servers inherit only the MCP SDK's short list of safe environment variables (HOME, PATH,
  …) plus their own env, so provider keys in Poke's environment never reach them. Their tools run
  without asking, as the brief says, with placeholders filled in and output redacted.
- **browse** is reached through `browse mcp` (stdio). The relay must be bound to the server's
  Tailscale IP (`browse set hostname <tailscale-ip>`), never 0.0.0.0. Each browser call first checks
  `status` and reports plainly when no browser is connected.
- Executor's app catalog is a public feed (`catalog.executor.sh/index.json`); nothing about the user
  is sent to fetch it.

## Memory (milestone 7)

- **The Claude subscription never serves memory.** The model gateway resolves only pi-ai providers;
  the Memory roles can't be given to the subscription (`providerAllowsRole`), and Voyage only serves
  embeddings.
- **The gateway is for Honcho only.** It listens on the docker bridge address, never on 0.0.0.0, and
  every request needs the gateway key (compared in constant time). It holds no provider keys itself:
  pi-ai and Voyage read them from the vault per request.
- **Only the real conversation reaches Honcho.** After each main-thread turn Poke writes his messages
  and its final reply, with every vault secret redacted first. Agent chatter and reports, tool
  output, secret requests and side chats are never written. Executors and side chats only have the
  read-only `recall`; `remember` is Poke's alone. Recall answers are redacted too.
- **Honcho runs with auth on** (`AUTH_USE_AUTH=true`), its API published only on 127.0.0.1, its
  database and cache on the compose network only. Poke's admin JWT, the JWT secret, the gateway key
  and the database password live in the vault's system namespace; the rendered env files that carry
  them for Docker are 0600 under `~/poke/services`, never in the repo. The CLI never prints them.
- Undo on a memory note deletes the conclusion in Honcho before the note changes state.

## Routines, skills and notifications (milestone 8)

- **Push bodies are redacted** like everything else, and short. A push carries a deep link with the
  message id, never a secret or a vault value.
- **Bark's device key** is a service key in the vault's system namespace, set from `poke setup` or
  `poke config bark.deviceKey` (prompted, never an argument). bark-server is published only on
  127.0.0.1; the tunnel (milestone 11) is its only way in.
- **Skills are instructions Poke follows**, so they're installed only when he asks for one (a link,
  a file, a folder). Downloads are https only, capped at 25 MB and 20 skills, unpacked in a staging
  folder by the system `tar`/`unzip` (which refuse paths outside it), and only folders holding a
  valid SKILL.md are copied in, under a validated name. Like every agent, a skill's scripts run with
  Poke's full access to its machine.
- **Routines run unattended** with the same rules as any agent: Executor-gated calls still ask (a
  push breaks through Focus for them), and the run's report goes to Poke, never straight to him.

## iOS app (milestone 9)

- **The phone never contacts third parties for images.** Card images and logos come through
  `/v1/images` and `/v1/logos`, behind the device token. The proxy is an SSRF boundary: https on
  the default port only, no credentials in the URL, every resolved address must be public
  (loopback, private, link-local, CGNAT, multicast, ULA, IPv4-mapped and documentation ranges are
  refused), checked again in the socket's own lookup so DNS rebinding can't swap it, at most three
  redirects each re-checked, 8 s and 5 MB limits, raster image types only (no SVG), and
  `nosniff`. Results are cached on disk by URL hash for 7 days.
- **The Library's workspace view is read-only and stays inside the workspace.** Paths are resolved
  through symlinks and must stay under the root; `..`, dot-files and links that point outside are
  refused or hidden. Files download as `application/octet-stream` with `attachment`, never
  rendered.
- **Phone storage:** the session (server URL, device token, Cloudflare Access service token) is in
  the Keychain, this device only, after first unlock. The vault key is in the Keychain behind
  Face ID. The SQLite cache holds the thread as the server sent it (already redacted), the outbox
  and preferences. Vault entries, revealed secrets and secret_request values are never cached:
  the Vault screen keeps them in memory, clears them in the background and re-hides a revealed
  value after 30 seconds; a secret field is emptied once saved.
- **Unpairing** revokes the device on the server, clears the cache, the session and the vault key.
  A 4401 or 4403 on the event stream signs the app out.
- **Share tokens** can only `POST /v1/share`. The token is shown once in Settings and listed as a
  device that can be removed.
- **MCP servers added from the phone** take a key only as a vault placeholder in the header
  (`Bearer {{vault:<name>.key}}`); the app never sends the key itself.
- **`/icon.png`** is the only new unauthenticated route: a fixed image file.

## Voice (milestone 10)

- **AssemblyAI's key never leaves the server.** It lives in the vault's system namespace
  (`assemblyai.key`, set with `poke config`), is read per connection, and goes only in the
  `Authorization` header (never in a URL, so it can't reach a log). The phone talks only to Poke;
  the voice sockets take the same device token as the event stream, and share-only tokens are
  refused.
- **What AssemblyAI receives:** his microphone audio during dictation and calls, the text of
  messages read aloud, and Poke's reply text on calls. Message text is already redacted (vault
  values never reach the thread), so no secret is sent for speech. Read-aloud clips are cached on
  the server under `<data>/tts` (the newest 300), named by message id, voice and update time; the
  voice id is checked against `[A-Za-z0-9_-]` so it can't form a path.
- **A call is ordinary messages.** His turns go through `ThreadService.send` with origin `voice`,
  so redaction, approvals and memory apply as for typed text. Camera stills are stored as normal
  attachments and only the newest unused one is sent, with his next turn.
- **The phone's settings API is an allow-list.** `PATCH /v1/settings` can change only the
  wallpaper, voice, read-aloud preference, timezone and name; server settings (`public.url`,
  `browse.host`, `executor.org`…) stay CLI-only.
- **Audio on the phone:** the mic runs only while dictating or on a call (the call ends when the
  app leaves the screen; there is no background audio mode). Nothing recorded is written to disk.

## Updates, release pipeline and the tunnel (milestone 11)

- **The only unauthenticated routes** are the SideStore source and its IPAs:
  `GET /sidestore/<token>/source.json` and `GET /sidestore/<token>/Poke-<ver>-<build>.ipa`.
  SideStore can't send credentials, so a random path segment stands in for one: 24 random bytes
  (`sidestore.token`, base64url, made on first use), compared in constant time, and a wrong token
  gets the same 404 as a missing file. The IPA is the unsigned app (no secrets in it; fonts and
  wallpapers only). Rotate the token with `poke config sidestore.token --unset`; the next
  `poke status` makes a new one and the source has to be added again.
- **OTA updates are behind the device token** like every other `/v1` route. expo-updates only
  sends headers declared at build time, so `authorization` and the two Cloudflare Access headers
  are declared empty in `app.config.ts` and filled in after pairing
  (`setUpdateRequestHeadersOverride`). Asset paths are resolved through `realpath` and must stay
  inside the update's folder; the runtime version must match `[A-Za-z0-9._-]`. Updates aren't
  code-signed (brief section 23): they come only from Poke's own server over HTTPS, behind the
  token.
- **CI needs no secrets.** The release workflow builds unsigned (`CODE_SIGNING_ALLOWED=NO`) and
  publishes with the default `GITHUB_TOKEN` (`contents: write` on that job only); the other jobs
  are read-only. SideStore signs on the phone with his Apple ID.
- **The GitHub token** (`github.token`, fine-grained, read-only Contents on the repo) stays in the
  vault's system namespace. `poke update` gives it to git through `GIT_CONFIG_*` environment
  variables for `https://github.com/` only, never as an argument or in `.git/config`, and sends it
  to the GitHub API only as a header. Release asset downloads follow GitHub's redirect to storage
  without it (fetch drops `authorization` on the cross-origin hop).
- **The tunnel token** (`cloudflare.tunnelToken`) goes from the vault into
  `~/poke/services/cloudflared.env` (0600), read by cloudflared as `TUNNEL_TOKEN`: never on a
  command line, so not in `ps` or the compose file. cloudflared runs with host networking and
  reaches only what the dashboard routes name: `localhost:7070` (Poke's API) and `localhost:8090`
  (bark-server). Its metrics listen on 127.0.0.1 only.
- **No open ports.** The API, Honcho and bark-server listen on 127.0.0.1; the model gateway on the
  Docker bridge; the browse relay on the Tailscale IP. SETUP.md has the ufw rules (deny incoming,
  allow Tailscale, allow Docker networks to the gateway port).
- **Updates roll back.** `poke update` refuses a checkout with local changes, backs up `poke.db`
  before migrating, and on any failure restores the previous commit, the backup and the previous
  build, and removes the new JS update so phones don't fetch it.
- **The Live Activity** shows the task name and step line on the Lock Screen, visible without
  unlocking. Step lines are already redacted (no vault values). It needs no App Group, so no data
  is shared with the extension outside ActivityKit's content updates.

## Doctor, backups and side chat cards (milestone 12)

- **A backup holds the master key** next to the encrypted vault, so the archive is as sensitive as
  the vault itself. It is written 0600 into `~/poke/backups` (0700); the command says so every
  time. It isn't encrypted again: a passphrase would be one more secret to keep with the file.
  Logs, caches and app updates are left out.
- **Restore never deletes.** What it replaces goes to `~/poke/restore-previous-<time>/` (the
  master key keeps 0600, `keys` 0700). Archive paths are checked: none may be absolute or contain
  `..`. A file that isn't a Poke backup is refused before anything is moved.
- **Doctor** reads only whether secrets exist and when they were saved, never their values. Its
  Bark check sends a fixed test push through the server; its tunnel check asks the public URL for
  `/v1/health`, which needs no token and returns no data.
- **Side chat cards** use the same block API as the thread. A secret typed into a side chat's card
  goes straight into the vault; the side chat gets only the placeholder. Its approvals come only
  from Executor-gated calls, are logged like any other, and can't be decided by the side chat
  itself. Side chat Trace step labels are redacted like executors'. Closing the chat, or a server
  restart, expires anything still waiting.

## Review fixes (after milestone 12)

- **Revocation is immediate.** Revoking a device closes its open `/v1/events` and voice sockets,
  not just future requests.
- **Approvals are redacted whole.** Executor sees the filled-in call, so the title, details,
  reason, presentation and "always allow" offer it describes it with are redacted along with the
  arguments before an approval is saved, logged or shown.
- **Log lines are scrubbed.** While the vault is open, every journal and `poke.log` line passes
  through the vault redactor, so an upstream error that echoes a secret is written as
  `[vault:<name>]`.
- **Backups are private from the first byte.** The archive is written into a 0600 file made
  beforehand and renamed into place when complete; a failed run removes it.
- **One-time codes.** A gated call that's waiting for an OK doesn't use up a one-time code, and its
  resume doesn't fill placeholders again.
- **Side chat Bash secrets** go through a 0600 file the shell deletes before the command runs
  (DECISIONS 118), never the command line.
