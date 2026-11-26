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
