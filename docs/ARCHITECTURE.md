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
