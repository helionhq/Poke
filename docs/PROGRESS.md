# Progress

Milestones from the brief (section 26). Each ends with tests green, docs updated and a commit.

| # | Milestone | Status |
|---|---|---|
| 1 | Scaffold: monorepo, tooling, boundaries, CI, contracts/domain skeletons, docs stubs | ✅ done |
| 2 | Server core: SQLite + migrations, thread/messages/events with seq, WS resume, attachments, pairing, admin socket, minimal CLI | ⏳ next |
| 3 | Runtimes: Pi Durable executors, Claude Agent SDK, model registry, `poke login` / `poke model`, traces, compaction, side chats | |
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
