# Progress

Milestones from the brief (section 26). Each ends with tests green, docs updated and a commit.

| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold: monorepo, tooling, boundaries, CI, contracts/domain skeletons, docs stubs | ✅ done |
| 2 | Server core: SQLite + migrations, thread/messages/events with seq, WS resume, attachments, pairing, admin socket, minimal CLI | ✅ done |
| 3 | Runtimes: Pi Durable executors, Claude Agent SDK, model registry, `poke login` / `poke model`, traces, compaction, side chats | ⏳ next |
| 4 | Blocks: catalog + `card`, state machines, actions API, agent tools, `ask_poke` parking | |
| 5 | Vault + approvals: encryption, placeholders, redaction, Face ID endpoints, ToolGateway, Executor approvals, always-allow | |
| 6 | Integrations: Executor bridge, Keenable, browse, local MCP | |
| 7 | Memory: model gateway, Honcho deploy, Voyage, recall/remember, digest | |
| 8 | Routines + skills + notifications | |
| 9 | iOS app: tokens/components from Doop, every screen, offline cache, deep links, share | |
| 10 | Voice: dictation, read aloud, call mode | |
| 11 | Live Activity, OTA updates, release pipeline, setup docs | |
| 12 | Polish pass | |

## Log

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
