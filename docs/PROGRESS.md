# Progress

Milestones from the brief (section 26). Each ends with tests green, docs updated and a commit.

| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold: monorepo, tooling, boundaries, CI, contracts/domain skeletons, docs stubs | ✅ done |
| 2 | Server core: SQLite + migrations, thread/messages/events with seq, WS resume, attachments, pairing, admin socket, minimal CLI | ✅ done |
| 3 | Runtimes: Pi Durable executors, Claude Agent SDK, model registry, `poke login` / `poke model`, traces, compaction, side chats | ✅ done |
| 4 | Blocks: catalog + `card`, state machines, actions API, agent tools, `ask_poke` parking | ✅ done |
| 5 | Vault + approvals: encryption, placeholders, redaction, Face ID endpoints, ToolGateway, Executor approvals, always-allow | ✅ done |
| 6 | Integrations: Executor bridge, Keenable, browse, local MCP | ⏳ next |
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
