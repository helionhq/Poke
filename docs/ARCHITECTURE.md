# Architecture

See the brief (`docs/BRIEF.md`, section 4) for the topology. This file describes the code as built.

## Layers

```
domain  ←  application  ←  apps (server, cli)
   ↑            ↑
contracts    agent-core            adapters/* implement domain ports
   ↑
 blocks      client ← mobile / web / cli
```

- `packages/domain`: entities (Message, Block, Task, Step, Trace, Routine, Skill, VaultEntry,
  Integration, ApprovalRequest/Rule, Attachment, Device, ModelAssignment), domain events, and ports
  (ConversationRuntime, ExecutorRuntime, MemoryPort, VaultPort, SearchPort, SpeechToText,
  TextToSpeech, Notifier, repositories…). No imports.
- `packages/application`: use cases and orchestrators.
- `packages/contracts`: zod wire contracts shared by server, clients and CLI.
- `packages/blocks`: the block catalog (schemas, state machines, fallback text).
- `packages/agent-core`: prompts and framework-neutral tool specs.
- `packages/adapters/*`: one adapter per port or external system.
- `apps/server`: composition root; `apps/cli`: the `poke` command.

The dependency rules are enforced by `pnpm boundaries`.

## Server (milestone 2)

`apps/server` composes the core:

- `kernel.ts`: opens `~/poke/data/poke.db` (`@poke/storage-sqlite`, `node:sqlite`, WAL, FTS5),
  creates the application services (`ThreadService`, `DeviceService`, `AttachmentService`,
  `SettingsService`, `EventHub`, `PresenceTracker`). No listeners, no runtimes. The CLI uses the
  kernel directly when the server is down.
- `server.ts`: two Fastify apps over the same services.
  - **public** on `127.0.0.1:7070` (the Cloudflare Tunnel's origin): `/v1/*`, device bearer tokens.
  - **admin** on the unix socket `~/poke/run/admin.sock` (0600; a named pipe on Windows dev
    machines): the same routes plus `/admin/*`. Every request on it is the owner, so the CLI needs
    no token. `/admin/*` does not exist on the public app.
- `http/route.ts`: one helper for every route: zod validation of body/query/params, the auth mode
  (`none`, `device`, `share`, `admin`), and the OpenAPI registry (`GET /v1/openapi.json`).
- `http/errors.ts`: `DomainError` codes → HTTP status, JSON `{ error: { code, message } }`.

### Storage and events

Every state change goes through `EventHub.commit`: one SQLite transaction saves the entity and
appends its persisted event(s) with a monotonically increasing `seq`, and subscribers are notified
only after the commit. Live-only events (`message.delta`, `agent.activity`, `task.progress`) carry
no seq (decision 6).

### Device auth

`poke config devices pair` asks the server for a single-use code (`XXXXX-XXXXX`, 10 minutes, only
its hash is stored) and prints `poke://pair?d=<base64url JSON {v, url, code}>` as a QR. `POST
/v1/pair` exchanges it for a token (`pk_` + 32 random bytes; only the sha256 is stored). Ten wrong
codes in ten minutes lock pairing for the rest of the window. Share-scope tokens (the iOS Shortcut)
can only call `POST /v1/share`.

### API (v1)

| Route | Auth | |
|---|---|---|
| `GET /v1/health` | none | version, protocol, uptime |
| `GET /v1/openapi.json` | none | generated from the zod contracts |
| `POST /v1/pair` | none | code → device token |
| `GET /v1/thread` | device | message count, first message date, latest seq |
| `GET /v1/thread/messages?before=&around=&limit=` | device | page of messages + their blocks and traces |
| `POST /v1/thread/messages` | device | send; idempotent on `clientMessageId` |
| `GET /v1/messages/:id`, `GET /v1/traces/:id` | device | one message (hydrated) / trace with steps and tasks |
| `GET /v1/search?q=&filter=` | device | FTS5 over message text, draft and block text |
| `POST /v1/attachments`, `GET /v1/attachments/:id` | device | multipart upload (`file`, ≤200 MB) / download |
| `POST /v1/share` | share | JSON `{text,url,urls,note}` or multipart; posts a `share` message |
| `GET/DELETE /v1/devices[/:id]`, `POST /v1/devices/share-token` | device | |
| `WS /v1/events?since=<seq>` | device | see below |

### Event stream

`WS /v1/events?since=<seq>`, authenticated with `Authorization: Bearer` or, from clients that
can't set headers, the subprotocols `["poke.v1", "poke.bearer.<token>"]` (the server answers with
`poke.v1` only). On connect the server subscribes first (buffering), then sends:

1. `{t:"hello", protocol, latestSeq, serverTime, reset}`: `reset` is true when the client is more
   than 5 000 events behind (or ahead of the server); it then refetches the thread instead.
2. `{t:"event", seq, at, event}` for every persisted event after `since`, in batches.
3. Buffered events the replay didn't cover, then `{t:"snapshot", streaming, activity}` with
   in-flight messages and Poke's activity.
4. Live: `event` and `{t:"live", event}` frames.

Clients send `{t:"ping"|"presence", presence:"foreground"|"background"}`; presence decides whether
a notification goes out (no Bark push while any client is foregrounded).

## Agents (milestone 3)

`apps/server/src/stack.ts` composes everything that thinks, on top of the kernel:

```
vault.db ─ LoginService ─┬─ pi-ai models (keys per request) ─ PiModelCatalog ─┐
                         └─ ClaudeModelCatalog (supportedModels / curated) ────┴─ ModelService
durable.sqlite ─ PiHost ─┬─ PiExecutorRuntime ──────── AgentsService ─┐
                         └─ PiConversationRuntime ─┐                  │
ClaudeConversationRuntime (Agent SDK) ─────────────┴─ InteractionOrchestrator (Poke)
                                                   └─ SideChatService
ToolGateway (parse → run → redact) ── every tool of every agent
```

The CLI opens only the top row (`openModelStack`) when the server is down, for `poke login` and
`poke model`.

### Poke's turn loop (`InteractionOrchestrator`)

- Inputs are user messages (from `ThreadService.onUserMessage`) and system inputs: agent reports,
  failures and questions (`<agent_report agent="…" id="tsk_…">…</agent_report>`, `<agent_failed>`,
  `<agent_question>`).
- One turn at a time. A user message that arrives mid-turn **steers** the running turn; if the
  runtime says the turn already ended, it queues. Queued inputs run together as one turn with one
  `<context>` block (time, timezone, whether the app is open, location, running agents).
- The reply streams as `message.delta` live events into one Poke message per turn, created on the
  first text. Text segments around tool calls join with a blank line. A report turn writes into the
  trace's message when it has no text yet.
- The session is opened per assignment (`provider/model/reasoning`). It resumes the stored session
  (`sessions` table, key `poke`) when the runtime is the same; otherwise it starts fresh with a digest
  (`digest.ts`). Usage goes to the `usage` table, context tokens and cache lifetime to the session.
- Problems become one system note each (no model, not logged in, usage limit with its reset time,
  quota, model gone, provider error), not repeated while nothing but user messages follow.

### Executors (`AgentsService` + `PiExecutorRuntime`)

- `send_to_agent` (Poke's tool) creates a trace for the turn (a Poke message with a `trace` part),
  saves the task, and starts an ownerless Pi Durable conversation with the Agents model, the executor
  prompt, the first turn `<goal>…</goal><background>…</background>`, Pi's coding tools, codemode,
  tool search and Poke's executor tools (`report_progress`, `ask_poke`).
- Tool calls become steps (`step.started` / `step.completed`) with a label and an app icon; the
  trace counts them. `report_progress` updates the task's live progress line.
- `ask_poke` saves the question as the task's need, tells Poke, and returns `park`: the Pi tool
  sleeps on the durable signal `poke.need`. Poke answers with `send_to_agent` and the agent id;
  `resolveNeed` fires the signal and the tool returns the answer. A parked task survives restarts.
- The executor's last message is its report. Poke gets it as a system input and answers under the
  trace. Cancel aborts the conversation quietly (no report turn).
- On boot, `AgentsService.resume()` re-binds every active task to its conversation and resumes the
  harness.

### Runtimes

| | Claude Agent SDK | Pi Durable |
|---|---|---|
| Used for | Poke, Side chat (subscription) | Poke, Side chat, executors (Qwen Token Plan) |
| Session | one streaming `query()` fed by an input queue; resume by session id | durable conversation in `durable.sqlite` (side chats: in memory) |
| Poke's tools | in-process MCP server `poke`; Claude Code's own tools off (side chats: Bash/Read/Write/Edit/Glob/Grep) | Pi tools wrapping the same gateway |
| Steering | `priority: "now"` | `submit({ whenBusy: "steer" })` |
| Threshold compaction | Claude Code, window = budget (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`), PreCompact supplies instructions | Pi, capped at the budget via `modelOverrides` |
| Idle compaction | Poke sends `/compact` (1-hour cache only) | `conv.compact()` when `context.idleCompactPi` |
| Credentials | `CLAUDE_CODE_OAUTH_TOKEN` in an allowlisted env | a read-only credential store over the vault |

### Tool gateway

`ToolGateway` holds one handler per tool with the profiles that may call it (`poke`, `executor`,
`sidechat`). Every call is parsed with the tool's zod schema, run, and its output, details and
structured content redacted with `SecretRedactor`. Runtimes call it through the `ToolInvoker` port;
Pi's coding tools and Claude Code's built-ins go through the `ToolInterceptor` (prepare before,
redact after). Vault placeholders are resolved in `prepare` from milestone 5.

### API (milestone 3 additions)

| Route | Auth | |
|---|---|---|
| `GET /v1/context`, `POST /v1/context/compact` | device | Poke's tokens, budget, last compaction / compact now |
| `GET /v1/tasks?all=`, `GET /v1/tasks/:id`, `POST /v1/tasks/:id/cancel` | device | agents |
| `GET /v1/models` | device | role assignments (the app shows "not set" notices) |
| `GET/POST /v1/sidechats`, `GET/DELETE /v1/sidechats/:id` | device | open, list, read, close |
| `POST /v1/sidechats/:id/messages`, `/cancel`, `/send-to-poke` | device | send (reply streams), stop, summary to the thread |
| `GET /admin/logins`, `POST/DELETE /admin/logins/:id` | admin | validate and save / remove a credential |
| `GET /admin/models`, `GET /admin/models/providers/:provider`, `PUT/DELETE /admin/models/:role` | admin | roles with allowed providers, a provider's models, set / unset |

## Blocks (milestone 4)

The full model is in [BLOCKS.md](BLOCKS.md). In short:

```
Poke's block tools ───────────────┐
ask_poke (secret / connection) ───┼─ BlockService.attach ─ blocks table ─ block.created
                                  │
POST /v1/blocks/:id/actions ──────┴─ BlockService.act ─ @poke/blocks state machine
                                       ├─ side effect (vault write / sign-in / approval)
                                       ├─ blocks + block_actions tables ─ block.updated
                                       └─ owner: user message (choices) │ <block_action> to Poke │
                                                 resolveNeed → parked ask_poke resumes
```

- `packages/blocks` is pure (zod only): each kind's props, states, actions, fallback and search
  text, and `applyAction`, which every transition goes through.
- `BlockService` (application) runs actions one at a time per block and once per
  `clientActionId`, writes secrets straight to the vault, and tells whoever is waiting.
- `InteractionOrchestrator` registers Poke's block tools (each attaches to the reply being written),
  turns agents' needs into inputs that carry the block to attach once Poke has replied, and queues
  `<block_action>` inputs.
- Thread search indexes each block's search text with its message; the digest shows blocks as
  `[kind, state: fallback]`.

### API (milestone 4 additions)

| Route | Auth | What |
|---|---|---|
| `GET /v1/blocks/:id` | device | one block |
| `POST /v1/blocks/:id/actions` | device | act on a block: `{action, payload?, clientActionId}` → `{block, result?, duplicate}` |

## Vault and approvals (milestone 5)

```
tool call ─ ToolGateway ─┬─ parse
                         ├─ SecretResolver (resolveSecrets tools; Pi bash/write/edit via the interceptor)
                         ├─ run ── Executor-gated? ── ApprovalService.gate ─┬─ rule matches → run
                         │                                                  └─ park on an approval need
                         └─ SecretRedactor → [vault:name]
approval need → Poke's reply + draft / action / tool_approval block → BlockService.act
             → ApprovalService.decide → the parked call resumes
```

- `SecretResolver` (application) reads the vault port: values for arguments, environment variables
  for shells, `markUsed` after the call.
- `ApprovalService` stores requests and rules (`approvals`, `approval_rules`, `approval_log`),
  matches rules with `logic.ts`, and resumes the parked agent with
  `{allowed, approvalId, ruleId?, note?, final?}`.
- `VaultProofs` (server infra) issues and checks the Face ID challenges for the vault routes.
- Migration 3 adds `devices.vault_key` and the approvals' `presentation` and `offer`.

### API (milestone 5 additions)

| Route | Auth | What |
|---|---|---|
| `POST /v1/vault/challenge` | device with an enrolled key | a challenge for `{action, name?}` |
| `GET /v1/vault` | device + proof | entries, metadata only |
| `POST /v1/vault/entries`, `PATCH/DELETE /v1/vault/entries/:name` | device + proof | add, edit, delete |
| `POST /v1/vault/entries/:name/reveal` | device + proof | the entry's secret values |
| `GET /v1/approvals` | device | approvals waiting for an OK |
| `GET /v1/approvals/rules`, `DELETE /v1/approvals/rules/:id` | device | always-allow rules |

## Integrations (milestone 6)

```
executor_call / executor_execute ─ IntegrationService ─ ExecutorClient ─ MCP (model mode) ─ Executor Cloud
        │ approval-required                                    ▲
        └─ ApprovalService.gate ─ park ─ block ─ decide ─ resume ┘ accept / decline
connect_request "connect" ─ IntegrationService.start ─ userConnect ─ poll ─ block connected
mcp__<server>__* ─ SdkMcpConnector (stdio / HTTP)     browse_* ─ browse mcp (stdio) ─ relay ─ Chrome
search_web / fetch_pages ─ KeenableSearch
```

- Ports (domain): `McpConnector`/`McpSession`, `ExecutorPort` (run, resume, connect, connection,
  catalog), `SearchPort`.
- Adapters: `mcp-bridge` (MCP SDK client), `integrations-executor` (Executor protocol, catalog),
  `search-keenable`, `browse` (the `browse mcp` transport and its status reader).
- `IntegrationService` (application) registers the tools, settles Executor answers, runs sign-ins
  (it is BlockService's `ConnectionStarter`), connects local MCP servers and browse in the
  background at boot, and reconnects a dropped server after 30 s.
- Poke's prompt lists connected apps and MCP servers ("Connected apps").

### API (milestone 6 additions)

| Route | Auth | What |
|---|---|---|
| `GET /v1/integrations` | device | connected apps and whether Executor is set up |
| `GET /v1/integrations/catalog` | device | Executor's app catalog (cached an hour) |
| `GET /v1/integrations/mcp`, `POST /v1/integrations/mcp`, `DELETE /v1/integrations/mcp/:id` | device | local MCP servers |
| `GET /admin/keys`, `PUT/DELETE /admin/keys/:key` | admin socket | service keys (set or not; values never returned) |

## Memory (milestone 7)

```
main-thread turn ends ─ InteractionOrchestrator ─ MemoryService.recordExchange ─ HonchoMemory ─ Honcho (session main)
recall (Poke, executors, side chats) ─ MemoryService ─ peer arham .chat
remember (Poke) ─ conclusion ─ memory_note block ─ Undo ─ BlockService ─ forget
Honcho deriver / dialectic / summary / dream ─ http://host.docker.internal:7071/v1 ─ ModelGateway
        chat completions ─ pi-ai (Memory chat model)      embeddings ─ VoyageEmbeddings (1024)
```

- Ports (domain): `MemoryPort`, `Embeddings`.
- Adapters: `model-gateway` (OpenAI-compatible façade), `embeddings-voyage` (REST client, catalog,
  key check), `memory-honcho` (SDK 2.9.0).
- `MemoryService` (application) owns the writes, `recall`, the cached card (`PersonaSlots.memoryCard`,
  used by the prompt and the digest) and `forget`; `InteractionOrchestrator` registers `remember`
  because it shows the note under the reply.
- Deploy: `apps/server/src/infra/honcho-deploy.ts` renders `infra/compose/*.template` and mints the
  JWT; the CLI step (`apps/cli/src/commands/memory.ts`) runs git and `docker compose -p poke` with
  `infra/compose/docker-compose.yml`.

### API (milestone 7 additions)

| Route | Auth | What |
|---|---|---|
| `GET /v1/memory/recall?q=` | device | what's known about him (the Search screen's "From your history") |
| `GET /admin/memory` | admin socket | memory on, deployed, models, where the gateway listens |
| `POST /admin/memory/prepare`, `POST /admin/memory/finish` | admin socket | the setup steps: secrets and env files; the JWT once Honcho is up |

## Routines, skills, notifications (milestone 8)

```
RoutineService loop (Timers) ─ due ─ AgentsService.start (routineRunId) ─ executor
   report ─ InteractionOrchestrator (routine frame) ─ Poke reply = routine message │ wait = quiet
   └─ RoutineService.settle(run, messageId?)
SkillService ─ SkillFiles (apps/server FsSkillFiles: ~/poke/skills, staging, tar/unzip, GitHub tarballs)
   catalog ─ PersonaSlots.skillsIndex ─ every prompt     activate_skill / skill_install ─ Poke
   forTask ─ AgentsService first turn                    announcements ─ Poke's next turn context
NotificationService ─ hub (message events) ─ presence ─ redact ─ BarkNotifier ─ bark-server /push
```

- Domain: `SkillFiles` port; `Routine`, `RoutineRun`, `Skill`, `Notifier` were there since milestone 2.
- Application: `routines/` (service, schedule maths on croner), `skills/` (service, SKILL.md parser),
  `notifications.ts`. Agent-core: `tools/routines.ts`, `tools/skills.ts`, the `routine` prompt.
- Adapters: `notify-bark`. Server: `infra/skill-files.ts`, `http/routes/routines.ts`.
- CLI: `commands/notifications.ts` (setup step "notifications").

### API (milestone 8 additions)

| Route | Auth | What |
|---|---|---|
| `GET /v1/routines` | device | routines with their schedule in words |
| `GET/PATCH/DELETE /v1/routines/:id` | device | one routine and its last 50 runs; pause, edit or delete it |
| `POST /v1/routines/:id/run` | device | run it now (the schedule stays) |
| `GET /v1/skills`, `GET/PATCH/DELETE /v1/skills/:name` | device | list, read (with the SKILL.md body), enable or disable, remove |
| `POST /admin/notifications/test` | admin socket | a test push |

## iOS app (milestone 9)

```
apps/mobile (expo-router screens)
   └─ PokeProvider ─ PokeClient (REST) ─ EventStream (/v1/events, resume by seq)
                   ─ ThreadStore "main" (messages, blocks, traces, steps, deltas, activity)
                   ─ Outbox (SQLite) ─ POST /v1/thread/messages (clientMessageId)
                   ─ Cache (expo-sqlite: thread snapshot, outbox, prefs)
   └─ @poke/ui-native (Doop components) ─ @poke/ui-tokens (tokens, fonts, wallpapers, mark)
```

- Packages: `@poke/client` (http, events, outbox, store, format), `@poke/ui-tokens`,
  `@poke/ui-native`. dependency-cruiser keeps `ui-*` free of the domain and the client, and the
  client free of the domain and application layers.
- The app follows docs/IOS.md: one paired session, a cached thread drawn at launch, the stream
  replaying from the cached seq, an outbox for everything sent.
- Server additions: `ImageProxy` (infra/image-proxy.ts) for card images and logos,
  `WorkspaceBrowser` (infra/workspace-browser.ts) for the Library, `InteractionOrchestrator.stop()`
  for the composer's stop button, integration account and capability edits, and the share
  endpoint taking small text files as text (Shortcuts).

### API (milestone 9 additions)

| Route | Auth | What |
|---|---|---|
| `POST /v1/thread/stop` | device | end Poke's turn and cancel the agents he started |
| `GET /v1/thread` | device | now also `vaultCount` (the agent sheet's number) |
| `GET /v1/images?src=` | device | a card image, fetched by the server (https, public hosts, raster only) |
| `GET /v1/logos/:domain` | device | a site's icon (apple-touch-icon, then favicon) |
| `GET /v1/library` | device | attachments: all, photos, files or from Poke; search; paging |
| `GET /v1/library/workspace?path=` | device | a folder in Poke's workspace |
| `GET /v1/library/workspace/file?path=` | device | download a workspace file |
| `POST /v1/integrations/:id/connect` | device | start a sign-in; returns the URL to open |
| `PATCH /v1/integrations/:id` | device | default account, a capability on or off |
| `DELETE /v1/integrations/:id/accounts/:accountId` | device | disconnect one account |
| `GET /icon.png` | none | Poke's mark, for Bark push icons |

## Voice (milestone 10)

```
phone mic ─ Mic (react-native-audio-api, 16 kHz PCM16, voice processing on calls)
   │  WS /v1/voice/dictate ──► AssemblyAiStt (dictation: max_accuracy) ──► partial/final text
   │  WS /v1/voice/call ─────► VoiceCall ─► AssemblyAiStt (realtime-agent model, turn detection)
   │                              │  each finished turn ─► ThreadService.send(origin "voice")
   │                              │        └─► InteractionOrchestrator: voice note + voiceReasoning
   │                              │  hub message.delta of the reply ─► AssemblyAiTts stream (Generate)
   │                              │  reply complete ─► Flush
   ◄──────── PCM16 24 kHz ────────┘  SpeechStarted / partial while speaking ─► Cancel + "interrupt"
phone Speaker (AudioBufferQueueSourceNode; "interrupt" clears the queue)
POST /v1/tts {messageId} ─► AssemblyAiTts.speak (HTTP, WAV) ─► cache <data>/tts ─► playClip
```

- `@poke/speech-assemblyai`: `AssemblyAiStt` (Streaming STT v3) and `AssemblyAiTts` (TTS-1 over
  HTTP for whole clips and over WebSocket for calls). Both take the key from the vault's system
  namespace (`assemblyai.key`) on each connection. The domain ports (`SpeechToText`,
  `TextToSpeech`) describe sessions, not files: text is pushed in pieces, audio comes back as it
  is made, and `cancel` drops what's queued.
- `VoiceCall` (application/voice.ts) is transport-free: the WS route feeds it audio and control
  frames and sends what it emits. His turns go through the normal thread path, so a call is
  ordinary messages, steering works mid-turn, and Poke's tools, blocks and memory behave the same.
  Streamed reply text is spoken in whole words, never half a markdown link; markdown marks are
  dropped and bare URLs read as "a link".
- Barge-in: STT's `SpeechStarted` (or a non-empty partial) while Poke is speaking cancels the TTS
  stream, tells the phone to drop its queued audio and mutes the rest of that reply. His new turn
  steers the running turn and its reply is spoken again.
- Voice turns: `#turnInput` adds `voiceTurnNote` and sets `TurnInput.reasoning` to the Poke
  assignment's `voiceReasoning`. The Claude session switches effort for that turn with
  `Query.applyFlagSettings({ effortLevel })` (streaming input mode) and back on the next; the Pi
  session reconfigures its agent's thinking level the same way.
- Camera on a call: the phone sends a JPEG still every 2.5 s; the newest unused one is stored as
  an attachment and sent with his next turn.
- Settings: the phone reads and changes its own settings (`wallpaper`, `voice`, `readAloudAuto`,
  `timezone`, `name`) through `/v1/settings`; everything else stays with `poke config`.

### API (milestone 10 additions)

| Route | Auth | What |
|---|---|---|
| `GET /v1/voice` | device | whether voice is set up, the voice in use, the voices, sample rates |
| `POST /v1/tts` | device | `{messageId, voice?}` → the message read aloud as WAV (cached) |
| `WS /v1/voice/dictate` | device (full) | binary 16 kHz PCM16 in; `ready`, `partial`, `final`, `done` out; `{type:"stop"}` ends |
| `WS /v1/voice/call` | device (full) | binary PCM16 both ways; JSON `mute`, `frame`, `camera`, `end` in; `ready`, `state`, `user`, `poke`, `interrupt`, `error`, `ended` out |
| `GET /v1/settings` | device | the phone's settings |
| `PATCH /v1/settings` | device | change them (unknown keys are ignored) |

## Updates, release and the machine (milestone 11)

```
push to main ─► release.yml: fingerprint (ubuntu) ─ changed? ─► macOS: prebuild, archive unsigned,
                Payload/Poke.app (+ PlugIns/PokeLiveActivity.appex) ─► Poke-<ver>.ipa + release.json
                ─► GitHub Release ios-<build>-<sha7>-<fingerprint[:12]>

poke update ─► git fetch (token via GIT_CONFIG_*) ─► checkout ─► pnpm install, build
   └─► new CLI: update --apply <previous>
         expo export ─► ~/poke/updates/ota/<runtime>/<ms>-<sha7>/ (+ expoConfig.json, update.json)
         GitHub release for this fingerprint ─► ~/poke/updates/ipa/<build>/Poke.ipa + release.json
         stop poke.service ─► back up poke.db ─► migrate ─► compose (if infra/compose changed)
         start ─► health ─► (any failure: previous commit, DB backup, rebuild, restart)

phone (expo-updates) ─ GET /v1/updates/manifest (device token) ─► UpdateStore.latest(runtime)
                      ─ GET /v1/updates/assets/<runtime>/<dir>/<file>
SideStore ─ GET /sidestore/<token>/source.json ─► sideStoreSource(UpdateStore.releases())
          ─ GET /sidestore/<token>/Poke-<ver>-<build>.ipa
```

- `UpdateStore` (server/infra/updates.ts) only reads what `poke update` wrote. The manifest
  follows expo-updates protocol 1: multipart with `manifest` and `extensions` parts, or 204 when
  there is nothing for that runtime version. Asset hashes are base64url SHA-256 of the files; the
  id is a UUID derived from the export's metadata, so the same export always has the same id.
- `runtimeVersion` is the native fingerprint, so a JS update only reaches builds with the same
  native code, and the release workflow builds an IPA only when the fingerprint is new.
- `poke update` runs in two processes so migrations, compose rendering and the OTA export use the
  new code. Rollback is the previous commit rebuilt, not a copy of the old build.
- The machine: `poke.service` and `poke-update.timer` are systemd user units rendered from
  `infra/systemd` (lingering keeps them running); cloudflared joins the compose project under the
  `tunnel` profile once its env file exists. `poke start|stop|restart|logs` drive both.
- Live Activity: `targets/live-activity` (the extension, via `@bacons/apple-targets`) and
  `modules/poke-live-activity` (ActivityKit calls from the app). `src/live` maps tasks, steps and
  live lines to what the Lock Screen shows; `TaskActivities` starts, updates and ends activities;
  a background task refreshes them when iOS allows.

### API (milestone 11 additions)

| Route | Auth | What |
|---|---|---|
| `GET /v1/updates/manifest` | device | expo-updates manifest for `expo-runtime-version` (or 204) |
| `GET /v1/updates/assets/*` | device | an update's bundle and assets |
| `GET /sidestore/:token/source.json` | path token | the SideStore source |
| `GET /sidestore/:token/:file` | path token | an IPA |
| `GET /admin/updates` | admin | source URL and native builds (`poke status`) |
| `POST /admin/tunnel/prepare` | admin | render cloudflared.env from the vault |
