# Progress

Milestones from the brief (section 26). Each ends with tests green, docs updated and a commit.

| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold: monorepo, tooling, boundaries, CI, contracts/domain skeletons, docs stubs | ✅ done |
| 2 | Server core: SQLite + migrations, thread/messages/events with seq, WS resume, attachments, pairing, admin socket, minimal CLI | ✅ done |
| 3 | Runtimes: Pi Durable executors, Claude Agent SDK, model registry, `poke login` / `poke model`, traces, compaction, side chats | ✅ done |
| 4 | Blocks: catalog + `card`, state machines, actions API, agent tools, `ask_poke` parking | ✅ done |
| 5 | Vault + approvals: encryption, placeholders, redaction, Face ID endpoints, ToolGateway, Executor approvals, always-allow | ✅ done |
| 6 | Integrations: Executor bridge, Keenable, browse, local MCP | ✅ done |
| 7 | Memory: model gateway, Honcho deploy, Voyage, recall/remember, digest | ✅ done |
| 8 | Routines + skills + notifications | ✅ done |
| 9 | iOS app: tokens/components from Doop, every screen, offline cache, deep links, share | ✅ done |
| 10 | Voice: dictation, read aloud, call mode | ✅ done |
| 11 | Live Activity, OTA updates, release pipeline, setup docs | ✅ done |
| 12 | Polish pass | ✅ done |

## Log
### Milestone 12 — polish pass
- `poke doctor`: every check grouped (machine, Poke, logins, models, Docker, memory, tunnel,
  notifications, updates, backup), with the fix for each; `--fix` runs the ones it can, `--json`
  for scripts. The Claude token's expiry (save date plus a year) shows in doctor and `poke status`.
- `poke backup` and `poke restore`: one archive with consistent SQLite snapshots, the master key,
  his files, skills, settings, Bark's data and Honcho's database; restore moves what it replaces
  aside and reloads Honcho. Checked here end to end (backup) and in tests (round trip, a bad file).
- Side chats show what they did as a Trace under his message, and show cards: secret and connect
  requests (`ask_poke`) and Executor approvals, each waiting in the chat. Closing or stopping the
  chat expires what's waiting. This was the one gap left from milestone 9's side chat.
- Error states: the management screens, Library, Voices and Settings › Devices offer Try again;
  the Library shows a spinner while it loads instead of a blank screen.
- Not checked here: a screen-by-screen visual comparison with the Doop canvas on a phone (needs
  the app running on an iPhone; there's no simulator on Windows), `poke doctor --fix` and
  `poke restore` on the Ubuntu machine with Docker, and Honcho's dump and restore.
- Tests: 233 Vitest (new: side chat Trace and cards, expiry on close, backup round trip, doctor's
  token expiry and private files) and 21 Jest.


### Milestone 1 — scaffold
- pnpm workspaces + Turborepo; strict TS 6; ESLint (typescript-eslint, prettier); vitest at the root.
- Packages: `domain` (entities, events, ports), `contracts`, `blocks`, `agent-core`, `application`,
  `client`, `ui-tokens`, 13 adapters, apps `server`, `cli`, `web` (placeholder).
- Clean-architecture rules in `.dependency-cruiser.cjs`, run by `pnpm boundaries` and CI.
- Pinned Pi Durable family at exactly 1.6.1 and the Agent SDK at 0.3.332.
- Verified: pi-ai provider ids `qwen-token-plan-individual` / `qwen-token-plan-individual-cn` exist in
  1.6.1 with 13 models each (1M context); Agent SDK options `settingSources`, `persistSession`,
  `effort`, `thinking`, `plugins`, `skills`, `PreCompact`/`PostCompact`, `compact_boundary`,
  `supportedModels()`, `tool(…, { alwaysLoad, searchHint })`.

### Milestone 2 — server core
- `@poke/storage-sqlite`: `node:sqlite` (WAL, FTS5), migration 1 with every table the brief needs,
  synchronous repositories, `VACUUM INTO` backups. Message search indexes text plus draft/block text.
- `@poke/contracts`: zod entities, persisted/live events, WS frames, REST bodies, the settings map.
- `@poke/application`: `EventHub` (entity + event in one transaction, notify after commit), sortable
  ids, `ThreadService` (idempotent send, reply excerpts, paging, hydration), `DeviceService`
  (pairing codes, hashed tokens, share scope, rate limit), `AttachmentService`, `SettingsService`,
  presence.
- `apps/server`: kernel, public Fastify app on 127.0.0.1:7070 and admin app on the 0600 unix socket,
  REST routes, OpenAPI generated from the contracts, resumable `WS /v1/events`, uploads, the share
  endpoint, pino logs with a redaction hook.
- `apps/cli`: `poke setup` (preflight, data dirs + master key, profile, pairing; later milestones
  register their steps), `poke config` (settings and devices; secret keys register later),
  `poke status`. It talks to the admin socket when the server runs, otherwise it opens the kernel
  in-process.
- Tests: storage, contracts, kernel (pairing expiry and rate limit, idempotency), HTTP (auth scopes,
  uploads, share, WS replay and resume), admin socket end to end. 32 tests.
- Not yet: `poke start/stop/restart` (systemd plus the Docker services) and `install.sh` arrive with
  the services they manage.

### Milestone 3 — runtimes, agents, models
- `@poke/runtime-pi-durable` (Pi Durable 1.6.1): one durable harness on `~/poke/data/durable.sqlite`.
  Executors are ownerless conversations with Pi's coding tools (read/write/edit/bash, every call
  through Poke's interceptor), codemode, tool search and Poke's own tools. They stream steps, report
  usage, and park on `ask_poke` with a durable sleep on a `poke.need` signal, so a question
  survives a restart. Poke itself can run on Pi too (Qwen), with Pi's compaction capped at the budget.
  Provider keys come from the vault through a read-only credential store; pi-ai never reads env vars.
- `@poke/runtime-claude-agent-sdk` (Agent SDK 0.3.332): one long-lived streaming `query()` per
  session, fed by an input queue. Tools come from an in-process MCP server; Claude Code's own tools
  are off for Poke and limited to Bash/Read/Write/Edit/Glob/Grep for side chats. `settingSources: []`,
  no `--bare`, an environment built from an allowlist (no `ANTHROPIC_*` or other provider keys),
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set to the budget, PreCompact/PostCompact hooks, steering with
  `priority: "now"`, resume by session id with a fresh-plus-digest fallback. Refuses any role but
  Poke and Side chat.
- `@poke/application`:
  - `InteractionOrchestrator`: Poke's turn loop. Steers or queues inputs, streams one reply per turn,
    writes system notes for problems (no model, login, usage limit with reset time), records usage and
    the session, rebuilds from a digest when the runtime changes, runs Poke's own idle compaction
    (5.4), and answers messages that waited for a model.
  - `AgentsService`: executors, traces, steps, progress, questions, cancellation, resume on boot.
  - `ToolGateway` with `SecretRedactor`: every tool call is parsed, run and redacted (raw, base64,
    URL and JSON forms).
  - `ModelService` and `LoginService`: no defaults; Claude only for Poke and Side chat; models and
    reasoning levels validated against the provider's catalog; a role needs a logged-in provider.
  - `SideChatService`: in memory only, its own model role, "Send to Poke" summary.
- `apps/server`: `stack.ts` composes the vault (`vault.db`), logins, model catalogs (live Claude
  list via `supportedModels()`, curated fallback), the Pi host, both runtimes, the gateway, agents,
  Poke and side chats. New routes: context and compact, tasks, side chats, models, admin logins and
  models.
- `apps/cli`: `poke login [provider] [--logout] [--stdin]` (validates before saving; `anthropic`
  runs the bundled Claude Code's `setup-token` or takes a pasted token), `poke model` (6.2:
  role → provider → searchable model list → reasoning → voice reasoning, plus `set` / `unset` /
  `--json`), and the matching `poke setup` steps. `poke status` shows logins and live context.
- Tests: 84 in total. Pi with pi-ai's faux provider (tools, redaction, parking across a restart,
  steering, compaction), Claude with a scripted fake `query()` (options, env, hooks, event mapping,
  steering, compaction, resume fallback, rate limits), the orchestrator on the real kernel with fake
  runtimes and timers (streaming, steering, digest after a switch, agents, traces, questions, idle
  compaction rules, side chats), and the whole stack over HTTP with a real vault.
- Needs a live check with real credentials (no test can do it): a Claude turn on the subscription,
  the PreCompact hook's instructions reaching Claude Code's summary (decision 18), and a Qwen Token
  Plan turn.


### Milestone 4 — blocks
- `@poke/blocks`: the catalog from section 9.2 with props and slots that mirror the Doop components
  (`choices`, `draft`, `action`, `secret_request`, `connect_request`, `tool_approval`,
  `memory_note`) plus the composable `card` (13 safe primitives in a flat adjacency list, checked
  for references, cycles, depth, size and button/input limits). Each kind has a version, states,
  actions (who may send them, from which states, payload schema), fallback text and search text.
  `applyAction` runs every transition.
- `BlockService`: creates blocks under a message, runs actions one at a time per block and once per
  `clientActionId` (migration 2 adds `block_actions`, which never stores a payload), writes secrets
  straight to the vault, and tells the owner: a picked choice becomes the user's message, Poke gets
  `<block_action>`, a parked agent is resumed. Task-owned blocks expire when their task ends.
- Poke's tools `ask_choices`, `show_draft`, `propose_action`, `show_card`, `request_secret`,
  `request_connection`. `remember` (and so `memory_note`) comes with memory in milestone 7.
- `ask_poke` takes `question`, `secret` and `connection`. Secret and connection needs become blocks
  the server attaches under Poke's one-line reply (or on their own if Poke can't reply); saving or
  connecting resumes the agent, which gets the placeholder or the outcome.
- API: `GET /v1/blocks/:id`, `POST /v1/blocks/:id/actions`. Thread search uses each kind's search
  text; the digest shows blocks by their fallback.
- `docs/BLOCKS.md`: the model, the lifecycle, and how to add a kind.
- Waiting on later milestones: starting a sign-in for `connect` (Executor, 6), deciding
  `tool_approval` blocks and running a draft's primary action through approvals (5), Undo for
  `memory_note` (7), the card image proxy and the renderers (9). Until then those actions answer
  "can't … yet" and leave the block as it was.
- Tests: 102 in total, including the catalog (every state machine, card validation), a secret need
  end to end (the value appears nowhere but the vault), expiry on cancel, needs with no Poke model,
  choices, `<block_action>` for actions, drafts and cards, and the actions API over HTTP with a real
  vault (idempotency, 400/404/409).

### Milestone 5 — vault and approvals
- The vault (encrypted at rest since milestone 3) is now used without being seen. `SecretResolver`
  fills `{{vault:name.field}}` placeholders in at execution: Pi's `write` and `edit` get the values,
  `bash` gets quoted environment variables, and gateway tools opt in with `resolveSecrets`. Entries
  are marked used afterwards; one-time codes go after one use, or after 10 minutes (a sweep runs every
  minute).
- Redaction leaves `[vault:<entry>]` / `[vault:system]`.
- Face ID, checked on the server: an Ed25519 key enrolled at pairing and a signed single-use challenge
  per vault action. Vault routes: challenge, list, add, edit, delete, reveal.
- `ApprovalService`: the single gate for Executor-paused calls, always-allow rules with JSON-logic
  conditions, decisions logged with an arguments hash, presentation as a draft, an action card or a
  tool approval, and expiry with the task. Approval needs become blocks under Poke's reply, like
  secret and connection needs. Routes for pending approvals and rules.
- Migration 3: `devices.vault_key`, `approvals.presentation` and `approvals.offer`.
- Waiting on milestone 6: Executor's elicitations calling `gate`, and resuming or declining Executor
  in its `run`. Waiting on milestone 9: the app's key enrolment and signing (docs/IOS.md).
- Tests: 116 in total, including the resolver (values, shell quoting, unknown, missing and used-up
  secrets), redaction labels, JSON-logic, Pi write with a placeholder, gated calls end to end (park,
  block, allow with always, rule match, a send as an edited draft, expiry on cancel), and over HTTP
  the vault's Face ID proofs (missing, wrong purpose, replayed, forged, admin socket) and placeholder
  filling through the real vault.

### Milestone 6 — integrations
- Executor Cloud over MCP in model mode: the six meta-tools as `executor_*` tools. A paused call
  becomes an approval (draft, action card or tool approval, see decision 49) and Executor is resumed
  with the answer. An edited draft is re-sent once without a second OK.
- Sign-ins from a connect block: `userConnect`, polling until done, the account saved on the
  integration. Executor's app catalog from its public feed.
- Local MCP servers (stdio and HTTP) with vault placeholders in headers and env, as deferred
  `mcp__<server>__<tool>` tools; add them from the API or by asking Poke (`add_mcp_server`).
- browse through `browse mcp`, with a status check before each use.
- Keenable `search_web` and `fetch_pages` for every agent, and `vault_list`.
- CLI: `poke config executor.token` / `keenable.key` (prompt or `--stdin`), `poke config executor.org`.
- Poke's prompt lists connected apps.
- Protocol notes: docs/EXECUTOR-PROTOCOL.md.
- Not yet:
  - custom apps ("Set up by Poke") and MCP-by-URL through Executor are done by an agent with
    `executor_execute` (appManagement); there is no dedicated flow;
  - per-integration capability toggles (11.1) and choosing between several accounts are stored but not
    enforced yet; they come with their screens in milestone 9;
  - the browse relay's systemd unit and Tailscale binding go into the setup wizard in milestone 11.
- To verify live (needs the user's Executor token): the `userConnect` link field, and a real gated
  call end to end.
- Tests: 133 in total, including the MCP bridge against a real stdio server (env isolation), the
  Executor client against a fake Executor (pause, resume, already answered, connect, connection state,
  catalog), Keenable (vault key, keyless, failed pages), and end to end: a gated Executor call parked,
  approved from its block and resumed; the model refused when it tries to resume an approval; a
  sign-in moving its block to connected; an MCP server with a vault placeholder; the edited-draft pass.

### Milestone 7 — memory
- `@poke/model-gateway`: the OpenAI-compatible façade Honcho talks to, on port 7071 of the docker
  bridge address. Chat completions (plain and SSE, tools with ids that round-trip, json_object and
  json_schema replies) run on the Memory chat model through pi-ai; embeddings go to Voyage;
  `/v1/models` lists the aliases. Bearer auth with the gateway key; usage is recorded per role.
- `@poke/embeddings-voyage`: Voyage's REST API at 1024 dimensions, its model catalog (voyage-4,
  voyage-4-large) and `poke login voyage` validation.
- `@poke/memory-honcho`: workspace `poke`, peers `arham` (observed) and `poke` (not observed),
  session `main`; recall through `peer.chat`, remember/forget as conclusions, the peer card.
- `MemoryService` (application): writes his messages and Poke's final reply after each main-thread
  turn (redacted, in order, never blocking a turn), `recall` for Poke, executors and side chats,
  `remember` for Poke only with a `memory_note` whose Undo deletes the conclusion, and a cached peer
  card for the prompt and digest.
- Honcho deploy: `poke setup` (or `poke setup --only memory`) clones Honcho v3.6.2 into
  `~/poke/services/honcho`, renders `compose.env` and `honcho.env` (0600) from
  `infra/compose/*.template`, builds the image, starts Postgres and Redis, sizes the vector column on
  the empty database (`provision_db.py`, then `configure_embeddings.py --yes`), starts the API and
  deriver, and mints Poke's admin JWT.
- `GET /v1/memory/recall` (the Search screen's "From your history"), `/admin/memory` status,
  prepare and finish; `poke status` shows Memory and the gateway.
- Not yet: cloudflared joins the compose file in milestone 11 (Bark joined in milestone 8).
- To verify live (needs Docker, a Qwen key and a Voyage key): the Honcho build at v3.6.2, the
  deriver's JSON replies through Qwen (json_object), dialectic tool calls, and dreaming.
- Tests: 153 in total, including the gateway against pi-ai's faux provider (tool ids round trip,
  SSE, fenced JSON, embeddings, key checks), the Honcho adapter against a recording fetch (paths,
  peer observation config, conclusions), the env rendering (every module on the gateway, secrets
  kept across runs, every compose variable defined), and end to end: exchanges written with secrets
  removed, remember and Undo, recall for agents at the chosen depth, the card in Poke's prompt, and
  the gateway behind its key on the real stack.

### Milestone 8 — routines, skills, notifications
- Routines (`RoutineService`): Poke's `routine_create`, `routine_update`, `routine_delete` and
  `routine_list`; schedules once (a local time), cron (with a timezone) or every N minutes (5 or
  more), with optional `until` and `count`, read in his timezone and said in words ("Weekdays ·
  9:00 AM"). One loop sleeps until the next `nextRunAt` (at most 15 minutes at a time). A run starts
  an executor with the instructions; its report reaches Poke inside the `<routine>` frame, and Poke's
  reply becomes the routine's message (origin `routine`, the run's trace above it). If Poke waits,
  the run is quiet and nothing shows in the thread. Missed runs are caught up once at boot, marked
  late; one-shots turn themselves off after running; runs a restart cut short are marked failed.
- Skills (`SkillService`): `~/poke/skills/<name>/SKILL.md` read leniently per agentskills.io, kept
  in step with poke.db at start; the `<available_skills>` catalog in every prompt (enabled skills
  only, no block when there are none); `activate_skill` for Poke (an enum of enabled names, once per
  session, with the skill's resources listed); `send_to_agent`'s skills put the SKILL.md bodies in
  the agent's first turn; `skill_install` from a URL, a GitHub repo or folder, a zip or tarball, an
  attachment or a folder on the machine, announced to Poke in his next turn.
- Notifications: `@poke/notify-bark` posts Bark's `/push`; `NotificationService` pushes each
  finished Poke or system message in the main thread (redacted, 180 characters, deep link
  `poke://thread?message=<id>`, time-sensitive when a block waits on him) only when no app is in the
  foreground, once per message. `bark-server` v2.4.0 joined the compose file; `poke setup` step
  "notifications" starts it, explains the Bark app, takes the device key (or the whole server URL)
  and sends a test push. `bark.deviceKey` is a service key; `poke status` shows Push.
- API: `GET /v1/routines`, `GET/PATCH/DELETE /v1/routines/:id`, `POST /v1/routines/:id/run`,
  `GET /v1/skills`, `GET/PATCH/DELETE /v1/skills/:name`, `POST /admin/notifications/test`.
- Not yet: the push icon (served with the app icon in milestone 9); `poke doctor`'s test push
  (milestone 12); a Bark alert for provider failures comes for free, since those are system messages.
- To verify live: a push through bark.arham.im once the tunnel exists (milestone 11), and installing
  from a real GitHub URL (GitHub's tarball API, the system `tar`).
- Tests: 173 in total, including schedules (DST, cron in a timezone, intervals, until and count,
  wording), SKILL.md parsing (the spec's fields, lenient and strict cases, the YAML subset), the
  skills folder on disk (folders, a lone SKILL.md, https downloads, bad sources), Bark's request
  shape, and end to end: a routine created by chat that fires on time and lands as the routine's
  message, a quiet run, a late catch-up, app edits, the catalog and `activate_skill`, an install
  that's announced and handed to an agent, pushes with secrets taken out and none while the app is
  open, and the routines and skills API on the real stack.

### Milestone 9 — iOS app
- Packages: `@poke/ui-tokens` (the Doop canvas's colours for light and dark, type, radii, fonts,
  wallpapers, the mark, all bundled), `@poke/ui-native` (every Doop component in React Native:
  NavBar, Composer, ListRow and ListGroup, Trace and Step, MessageActions, menus, and all blocks
  through `BlockView`, with Liquid Glass and a blur fallback), `@poke/client` (REST, the resumable
  event stream with backoff and presence, the outbox, the thread store, formatting, deep links).
- App (`apps/mobile`, Expo SDK 58, expo-router): pairing by QR or link (makes the Face ID vault
  key); the thread with wallpapers, day dividers, streaming replies, traces that open into their
  steps, every block with haptics, long-press Copy / Select All / Reply, the add menu (recent
  photos, Camera, Photos, Files, Scan Document, Library) with uploads, pending and failed bubbles,
  and the stop button; search with filters and "From your history"; the agent sheet with the
  wallpaper picker and counts; side chat; Routines and a routine's page; Skills and a skill's
  page; the Vault behind Face ID (add, reveal, change, delete); Connect an app, an app's accounts
  and capabilities, Add an MCP server; the Library (attachments and the workspace); Settings
  (server, devices, share token, unpair); Always allowed; the voice screen's layout.
- Offline: the thread is cached in SQLite and drawn at launch; messages sent offline wait in the
  outbox and go out on reconnect. Deep links: `poke://thread?message=`, `poke://vault`,
  `poke://routines/:id`, `poke://pair?d=`.
- Native: a local Expo module for VisionKit's document camera (one PDF per scan).
- Server: image and logo proxy, Library API (attachments and the workspace), `POST /v1/thread/stop`,
  integration edits (connect, default account, capability on or off, disconnect one account),
  `vaultCount`, `/icon.png` for push icons (milestone 8's leftover), and share accepting text sent
  as a small file.
- Docs: IOS.md rewritten, SHARE_SHORTCUT.md (the Shortcut, step by step).
- Not yet: side chats render text only (the server's side chats reply in text; traces and blocks
  inside them come with the polish pass, done in milestone 12); voice audio (milestone 10); Live Activity and OTA
  (milestone 11).
- To verify on a phone (needs a Mac build): Face ID keys across SideStore refreshes, signing
  speed, the scanner module, Liquid Glass on iOS 26, and the Shortcut. `expo export` bundles the
  app on Windows and in CI.
- Tests: 192 Vitest (new: image proxy SSRF guards, workspace browser escapes, client store,
  outbox, events and formatting, share text files, the icon route) and 12 Jest in the app
  (base64url, pairing codes, vault signatures checked with Ed25519 verify, ListRow toggles,
  search highlighting).

### Milestone 10 — voice
- `@poke/speech-assemblyai`: streaming STT v3 (call and dictation models, key terms, turns that
  count only when formatted, Terminate waits for the last words), TTS-1 over HTTP (WAV, split under
  the length limit) and over WebSocket (Generate, Flush, Cancel, keep-alive), and the 34 documented
  voices. `assemblyai.key` joins the service keys (`poke config`).
- Server: `VoiceCall` (application) runs a call over the normal thread; `WS /v1/voice/dictate`,
  `WS /v1/voice/call`, `POST /v1/tts` (cached per message and voice), `GET /v1/voice`, and
  `GET/PATCH /v1/settings` for the phone's own settings.
- Voice turns: the spoken-style note and the Poke assignment's `voiceReasoning`, per turn, in both
  runtimes (Claude: `applyFlagSettings({ effortLevel })`; Pi: reconfigure the agent).
- App: dictation from the composer mic (words appear as he speaks; tap again or send to finish),
  read aloud in the chosen voice, the call screen (listening, thinking, speaking; his last words
  small, Poke's reply large; waveform from the mic; mute; camera with a small preview; end), and
  Settings → Voice. Audio through `react-native-audio-api` with the voice-chat session and echo
  cancellation on calls.
- CI: a macOS workflow (`ios.yml`) prebuilds and compiles the app unsigned when the app or its
  native inputs change.
- To verify on a phone (needs a Mac build and an AssemblyAI key): echo cancellation on the
  speaker, barge-in latency, the mic's delivered sample rate (resampled to 16 kHz if it differs),
  Bluetooth headsets, and the camera stills. The CI native build runs on the first push.
- Tests: 212 Vitest (new: the AssemblyAI adapter against a fake socket and fetch, VoiceCall's
  turns, speech, barge-in and camera frames, whole-word speech buffering, the voice routes and
  sockets, the settings allow-list, per-turn effort in the Claude runtime) and 17 Jest in the app
  (PCM conversion and resampling, dictation text, the dictation session against a fake socket).

### Milestone 11 — Live Activity, updates, release pipeline
- Updates server: the expo-updates protocol 1 (`/v1/updates/manifest`, `/v1/updates/assets/*`,
  behind the device token) over what `poke update` exports, and the SideStore source with its
  IPAs behind a random path token. The app fills in its update headers after pairing and checks
  on launch and resume. Checked against a real `expo export` (54 assets, every hash matches).
- Release pipeline: `release.yml` builds the unsigned IPA on macOS only when the native
  fingerprint has no release yet, checks the Live Activity extension is in `PlugIns/`, writes
  `release.json` (version, build, fingerprint, entitlements and usage descriptions read from the
  built app) and publishes a GitHub Release with `GITHUB_TOKEN`. `dev-client.yml` (manual) builds
  the development client; `ios.yml` now runs on pull requests and by hand only.
- Live Activity: a SwiftUI widget extension (`targets/live-activity`, `@bacons/apple-targets`)
  and a local ActivityKit module; tasks start one in the foreground, WS events update it, the
  outcome ends it, a background task refreshes it when iOS allows. No App Group.
  `POKE_LIVE_ACTIVITY=0` leaves it out.
- The machine: cloudflared in compose (host network, token from a 0600 env file, `tunnel`
  profile), `poke.service` and the nightly update timer as systemd user units, `install.sh`, and
  `poke start|stop|restart [service]`, `poke logs [service] [-f]`, `poke update` (two phases,
  backup, migrations, compose, OTA export, IPA download, health check, rollback). Setup gains the
  tunnel and service steps; `poke status` shows services, the tunnel, the native build and the
  SideStore source URL. `github.token` and `cloudflare.tunnelToken` join the service keys.
- Docs: SETUP.md written (install, setup steps, AssemblyAI, tunnel, running, updates, firewall,
  files); IOS.md has the SideStore flow from Windows, refreshes, updates and the Live Activity.
- Not checked here (needs a Mac, a phone, Docker or Cloudflare): the iOS prebuild and native build
  with the extension (CI runs it), free-team provisioning of the extension, the Live Activity on
  the Lock Screen, the compose file under Docker, the tunnel end to end, `poke update` on the
  machine, and the SideStore install and refresh (the Shortcuts action name is undocumented).
- Tests: 226 Vitest (new: the updates routes, maintenance (tunnel env, DB backup and restore),
  the update helpers (git auth env, release lookup, pruning), service names, tunnel tokens and the
  systemd units) and 21 Jest (Live Activity content and the activity controller).
