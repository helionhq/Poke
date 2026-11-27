# Blocks

Blocks are the interactive parts of the thread: choices, drafts, actions, secret and connection
requests, tool approvals, memory receipts, and the catch-all `card`. The agent fills a block in; the
server owns its state; the app draws it. (Brief section 9.)

## Where things live

| Piece | Place |
|---|---|
| Kind schemas, state machines, fallback and search text | `packages/blocks` (zod only) |
| Creating blocks, running actions, telling the owner | `packages/application/src/blocks.ts` (`BlockService`) |
| Poke's block tools (`ask_choices`, `show_draft`, …) | `packages/agent-core/src/tools/blocks.ts`, handlers in `interaction.ts` |
| Agents' needs (`ask_poke`) | `packages/agent-core/src/tools/core.ts`, handlers in `interaction.ts` |
| Storage | `blocks` and `block_actions` tables (migration 2) |
| HTTP | `GET /v1/blocks/:id`, `POST /v1/blocks/:id/actions` |
| Renderers | `packages/ui-native` (milestone 9), keyed by kind |

## The catalog

Props and slots mirror the Doop "Poke One" components. Text a component always shows ("Something
else…", "Save", "Not now", the fine print) is the app's, not the agent's.

| Kind (v1) | Doop component | States | Actions (by) |
|---|---|---|---|
| `choices` | Choices + Choice | `pending` → `answered` | `pick {index}`, `write {text}` (user) |
| `draft` | Draft | `idle` (`editing` is app-local) → `sent` | `edit {body, subject?, to?}`, `primary` (user) |
| `action` | ActionCard | `pending` → `confirmed` / `changed` / `cancelled` | `confirm`, `change {note?}`, `cancel` (user) |
| `secret_request` | SecretRequest | `pending` (`filled` is app-local) → `saved` / `expired` | `save {value}` (user, sensitive), `expire` (server) |
| `connect_request` | ConnectRequest | `pending` → `connecting` → `connected` / `dismissed` / `expired` | `connect`, `dismiss` (user); `connected`, `failed`, `expire` (server) |
| `tool_approval` | ToolApproval | `pending` → `allowed` / `denied` / `expired` | `allow {always?}`, `deny` (user); `expire` (server) |
| `memory_note` | MemoryNote | `saved` → `undone` | `undo` (user) |
| `card` | (primitives) | `active` → `closed` | `press {actionId, values?}` (user), `close` (server) |

One kind covers many shapes through its props: `secret_request` is a login (`secretType:
"password"`, `known: [Email …]`), an API key (no `known`) or a one-time code (`ephemeral`);
`connect_request` is a catalog app (`kind: "app"`) or one Poke set up (`kind: "custom"`, `source`).

### `card`

A flat adjacency list: `{title, root, nodes: {id: node}, data?}`. Nodes are `stack`, `row`,
`heading`, `text` (with `**bold**` and `[label](https://…)`), `kv`, `list`, `chips`, `image` (https
only; the app will load it through a server image proxy, milestone 9), `divider`, `field`, `toggle`, `button` (`actionId`,
tone) and `logo` (an app id or a domain, never an image URL). `data` holds the initial values of
fields and toggles.

Checked on creation: every reference resolves, no cycles, each node used once, every node reachable,
at most 6 levels, 60 nodes, 8 buttons, 8 inputs and 16 KB; unique `actionId`s and keys; inputs need a
button. A press sends `{actionId, values}`; values for keys the card doesn't have are dropped.

## Lifecycle

1. **Create.** Poke calls a block tool, or an agent's `ask_poke` need becomes a block (below).
   `BlockService.attach` validates the props against the kind, stores the block with its first state
   and its `fallback` text, adds a `{type: "block", blockId}` part to the message, and emits
   `block.created` and `message.updated`.
2. **Act.** The app sends `POST /v1/blocks/:id/actions {action, payload, clientActionId}`. The
   server checks the action exists for the kind, may be sent by a user, is allowed from the current
   state, and that the payload matches. Actions on one block run one at a time.
3. **Side effects first.** A secret is written to the vault, a sign-in is started, an approval is
   decided. If that fails, the block doesn't change.
4. **Save.** The new state, resolution and fallback are stored (`block.updated`), and the action is
   recorded under its `clientActionId` with its result (never its payload). A retry with the same id
   gets the same answer and `duplicate: true`; the same id for another block or action is a 409.
5. **Tell the owner.**
   - `choices`: the answer is posted as the user's next message.
   - Poke's own blocks: a system input
     `<block_action block="blk_…" kind="action" title="Lilia">confirmed</block_action>`. Draft
     edits and card closes say nothing; a draft's primary action sends the final text.
   - An agent's need: the parked `ask_poke` call is resumed through `AgentsService.resolveNeed`.
   - A tool approval: the approval it belongs to is decided (milestone 5).

Errors: unknown block 404; wrong state 409 ("It's already saved"); a bad payload 400 (a sensitive
payload only ever says "That value can't be saved"); no connection starter or approval decider yet
503.

## Agents' needs

An executor calls `ask_poke` with `kind` `question`, `secret` or `connection`. The task parks on the
durable signal `poke.need` and Poke gets a system input:

- `question` → `<agent_question>`. Poke rephrases it, often with `ask_choices`, and answers with
  `send_to_agent`.
- `secret` → `<agent_needs_secret>`. Poke writes one line; the server builds the `secret_request`
  (title, the agent's reason, the known fields with the service first, the vault name) and attaches
  it under that reply. Saving writes the vault entry and resumes the agent with
  `{status: "saved", vaultName, placeholder}`.
- `connection` → `<agent_needs_connection>`, the same way with a `connect_request`. The agent hears
  `connected` or `dismissed`.

If Poke can't reply (no model, an error), the block goes into a Poke message of its own, so the
agent isn't stuck. When a task ends, its open need blocks expire; on boot, blocks for needs nobody
waits on any more expire too.

## Adding a kind

1. **Schema and state machine** in `packages/blocks/src/kinds.ts` (or its own file): props that
   mirror the Doop component's props and slots, `initial`, `states`, `terminal`, actions with
   `from`, `by`, payload and `apply`, `fallbackText`, `searchText`. Register it in `CATALOG` and
   bump `BLOCK_CATALOG_VERSION`. Changing an existing kind's props incompatibly bumps its `v`.
2. **Side effects and the owner's notice** in `BlockService` (`act` and `pokeNotice`).
3. **Agent tool** in `packages/agent-core/src/tools/blocks.ts`, with a description that says when to
   use it and what comes back, and its handler in `InteractionOrchestrator`.
4. **Renderer** in `packages/ui-native`, keyed by kind. A client that doesn't know a kind or
   version draws it as a `card` if it can, else its `fallback` text.
5. **Tests** in `packages/blocks/src/blocks.test.ts` and the server tests.
