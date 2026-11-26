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
| 10 | Server | Two Fastify apps over one kernel: **public** on 127.0.0.1:7070 and **admin** on a 0600 unix socket (`~/poke/run/admin.sock`). The admin socket needs no token. | The CLI runs as Poke's own user, which already owns `~/poke`. A socket can't be reached through the tunnel, so `/admin/*` never exists on the TCP listener. |
| 11 | CLI | When the server is down, the CLI opens the kernel in-process (same `poke.db`). | `poke setup`, `login`, `config` and `model` must work before the server is installed. SQLite WAL and a busy timeout keep the two safe if both run. |
| 12 | Auth | Device tokens are `pk_` + 32 random bytes, stored as sha256. The WebSocket also accepts the subprotocol `poke.bearer.<token>` next to `poke.v1`. | React Native's WebSocket can't always set headers. The server only ever echoes `poke.v1`. |
| 13 | Pairing | The QR encodes `poke://pair?d=<base64url JSON {v:1,url,code}>`. Codes are `XXXXX-XXXXX` from a 31-character unambiguous alphabet (~50 bits, rejection-sampled), single use, 10 minutes. | Scannable by the iOS camera (deep link) and typeable by hand. |
| 14 | Events | WS resume replays at most **5 000** events. Further behind (or ahead, after a restore), the server sends `hello.reset` and the client refetches the thread. | Bounded reconnect cost; the thread endpoint is the faster path after a long absence. |
| 15 | Tests | vitest resolves with the conditions `source, node, development` (not `import`). | With `import`, `ws` resolves to its ESM wrapper and `@fastify/websocket` (CJS) breaks. |
| 16 | Share | `POST /v1/share` takes JSON `{text,url,urls,note}` or multipart (files + fields) with a share-scope token. | The iOS Shortcut can send either; the scoped token limits what a leaked Shortcut can do. |
