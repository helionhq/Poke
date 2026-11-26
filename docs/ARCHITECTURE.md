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
