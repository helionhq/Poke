# Decisions

Defaults picked while building, where the brief left room. Newest last. Locked decisions from the
brief (section 2) are not repeated here.

| # | Area | Decision | Why |
|---|---|---|---|
| 1 | Tooling | **TypeScript 6.0.3**, not 7.0. | typescript-eslint 8.74 supports `typescript <6.1`. Revisit when it supports the Go-based TS 7. |
| 2 | Storage | `poke.db` uses **`node:sqlite`** with hand-written SQL migrations, not Drizzle + better-sqlite3. | No native module to compile on the server or in CI, the same SQLite build Pi Durable uses, FTS5 included. Drizzle has no `node:sqlite` driver in 0.45. |
| 3 | Packages | Workspace packages export TypeScript source under a `source` export condition, and built `dist/` for everything else. | vitest, Metro and `node --conditions=source` read source directly (no build before tests); production runs compiled JS. |
| 4 | Domain | Repository ports are **synchronous**. | `poke.db` is embedded SQLite owned by one process; sync calls make "save entity + append event" one transaction. |
| 5 | Domain | `packages/domain` may use global types (`AbortSignal`) but imports nothing. | Both Node and React Native provide them; the dependency rule is about imports. |
| 6 | Events | `message.delta`, `agent.activity` and `task.progress` are **live-only** (no seq). Persisted events carry full snapshots (`message.updated` etc.). | Persisting every token is wasteful; a reconnecting client replays persisted events from `since`, then gets a snapshot of in-flight messages. |
| 7 | Boundaries | Enforced with **dependency-cruiser** (`pnpm boundaries`, CI). | Works on resolved paths across pnpm symlinks; rules in `.dependency-cruiser.cjs`. |
| 8 | Layers | `application` may import `blocks` and `agent-core` as well as `domain` and `contracts`. | Both are pure, platform-agnostic packages (catalog + prompts/tool specs). |
| 9 | Docs | The full brief is kept at `docs/BRIEF.md`. | It is the spec every milestone is checked against. |
