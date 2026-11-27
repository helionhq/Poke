import {
  applyAction,
  BlockActionError,
  canApply,
  isTerminal,
  newBlock,
  type SecretRequestProps,
  type SecretType,
} from "@poke/blocks";
import {
  type Block,
  type BlockOwner,
  type Clock,
  DomainError,
  type IdGenerator,
  type Logger,
  type Message,
  type Repositories,
  type VaultKind,
  type MemoryPort,
  type VaultPort,
} from "@poke/domain";
import type { AgentsService } from "./agents.js";
import type { EventHub } from "./core/hub.js";
import type { ThreadService } from "./thread.js";

/** Starts signing in to an app (Executor, milestone 6). It finishes later via BlockService.system(). */
export interface ConnectionStarter {
  start(input: { app: string; kind: "app" | "custom"; blockId: string }): Promise<{ url: string }>;
}

/** What the user decided about a gated call, from whichever block showed it. */
export interface ApprovalDecision {
  allowed: boolean;
  /** "Always allow …" was ticked. */
  always?: boolean;
  /** Asked for a change instead (action card), in their words. */
  note?: string;
  /** A draft edited before sending: its final fields. */
  final?: Record<string, unknown>;
}

/** Decides a gated tool call (ApprovalService). */
export interface ApprovalDecider {
  decide(approvalId: string, decision: ApprovalDecision): Promise<void>;
}

/** An approval block reaching a final state is the decision. Undefined: not decided yet. */
function approvalDecision(
  block: Block,
  state: string,
  resolution: Record<string, unknown> | undefined,
  props: Record<string, unknown> | undefined,
): ApprovalDecision | undefined {
  switch (block.kind) {
    case "tool_approval":
      if (state === "allowed")
        return { allowed: true, ...(resolution?.always === true ? { always: true } : {}) };
      return state === "denied" ? { allowed: false } : undefined;
    case "action":
      if (state === "confirmed") return { allowed: true };
      if (state === "changed" || state === "cancelled")
        return { allowed: false, ...(typeof resolution?.note === "string" ? { note: resolution.note } : {}) };
      return undefined;
    case "draft": {
      if (state !== "sent") return undefined;
      const current = props ?? block.props;
      const edited = block.resolution?.edited === true;
      const final = Object.fromEntries(
        ["to", "subject", "body"].flatMap((key) => (current[key] !== undefined ? [[key, current[key]]] : [])),
      );
      return { allowed: true, ...(edited ? { final } : {}) };
    }
    default:
      return undefined;
  }
}

/** What Poke hears when Arham acts on one of its blocks. */
export interface BlockActionNotice {
  block: Block;
  action: string;
  text: string;
}

export interface BlocksDeps {
  repos: Repositories;
  hub: EventHub;
  ids: IdGenerator;
  clock: Clock;
  log: Logger;
  thread: ThreadService;
  vault: Pick<VaultPort, "get" | "put" | "update">;
  agents: Pick<AgentsService, "resolveNeed">;
  connections?: ConnectionStarter;
  approvals?: ApprovalDecider;
  /** Undo on a memory note deletes what was saved. */
  memory?: Pick<MemoryPort, "forget">;
}

export interface BlockActionInput {
  action: string;
  payload?: unknown;
  /** Chosen by the app; a retry with the same id gets the same answer instead of acting twice. */
  clientActionId: string;
}

export interface BlockActionResult {
  block: Block;
  /** Anything the app needs next, e.g. the sign-in URL to open for `connect`. */
  result?: Record<string, unknown>;
  duplicate: boolean;
}

/** One-time codes are wiped after this long if nothing used them. */
const CODE_TTL_MS = 10 * 60 * 1000;

const SECRET_FIELD: Record<SecretType, string> = {
  password: "password",
  api_key: "api_key",
  code: "code",
  card: "number",
  text: "value",
};

const VAULT_KIND: Record<SecretType, VaultKind> = {
  password: "login",
  api_key: "api_key",
  code: "code",
  card: "card",
  text: "note",
};

/** The placeholder an agent uses for a secret a secret_request saved. */
export function secretPlaceholder(props: Pick<SecretRequestProps, "vaultName" | "secretType">): string {
  return `{{vault:${props.vaultName}.${SECRET_FIELD[props.secretType]}}}`;
}

/**
 * Interactive blocks in the thread (section 9): created by Poke's tools and by agents' needs,
 * acted on from the app. Every action goes through the kind's state machine in @poke/blocks,
 * once per clientActionId, one at a time per block. A secret typed into a block goes straight to
 * the vault and is never stored, logged or echoed anywhere else.
 */
export class BlockService {
  readonly #listeners = new Set<(notice: BlockActionNotice) => void>();
  readonly #locks = new Map<string, Promise<unknown>>();
  #sideChats: { settle(key: string, value: unknown): void } | undefined;

  constructor(private readonly deps: BlocksDeps) {}

  /** Expire blocks whose agents stopped waiting while the server was down, and follow task ends. */
  start(): void {
    for (const block of this.deps.repos.blocks.pending()) {
      // Side chats don't outlive the server: nothing waits on their cards any more.
      if (block.scope.startsWith("sidechat:")) {
        this.#expire(block);
        continue;
      }
      if (block.owner.type !== "task") continue;
      const task = this.deps.repos.tasks.get(block.owner.taskId);
      if (!task || task.need?.id !== block.owner.needId) this.#expire(block);
    }
    // Approval cards (drafts and action cards too) whose agent no longer waits for that OK.
    for (const request of this.deps.repos.approvals.pending()) {
      if (request.requester.kind !== "task") continue;
      const need = this.deps.repos.tasks.get(request.requester.taskId)?.need;
      if (need?.kind !== "approval" || need.approvalId !== request.id)
        this.expireTask(request.requester.taskId);
    }
    this.deps.hub.subscribe((frame) => {
      if (frame.kind !== "event") return;
      const event = frame.stored.event;
      if (event.type !== "task.updated" && event.type !== "task.completed") return;
      const { task } = event;
      if (task.status === "running" || task.status === "waiting") return;
      this.expireTask(task.id);
    });
  }

  onPokeAction(listener: (notice: BlockActionNotice) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get(id: string): Block {
    const block = this.deps.repos.blocks.get(id);
    if (!block) throw new DomainError("not_found", "Block not found");
    return block;
  }

  /** Validate and add a block under a message (appending a block part to it). */
  attach(message: Message, input: { kind: string; props: unknown; owner: BlockOwner }): Block {
    let created: ReturnType<typeof newBlock>;
    try {
      created = newBlock(input.kind, input.props);
    } catch (error) {
      if (error instanceof BlockActionError) throw new DomainError("invalid", error.message);
      throw error;
    }
    const now = this.deps.clock.now();
    const block: Block = {
      id: this.deps.ids.next("blk"),
      kind: created.kind,
      v: created.v,
      props: created.props,
      state: created.state,
      fallback: created.fallback,
      owner: input.owner,
      messageId: message.id,
      scope: message.scope,
      createdAt: now,
      updatedAt: now,
    };
    message.parts.push({ type: "block", blockId: block.id });
    message.updatedAt = now;
    this.deps.hub.publish(() => {
      this.deps.repos.blocks.save(block);
      return [{ type: "block.created", block }];
    });
    // Side chat messages live only in memory; the side chat publishes the change itself.
    if (!message.scope.startsWith("sidechat:")) this.deps.thread.saveMessage(message, "updated");
    return block;
  }

  /** Where side chat blocks report back (set once the side chats exist). */
  attachSideChats(sideChats: { settle(key: string, value: unknown): void }): void {
    this.#sideChats = sideChats;
  }

  /** Ends a block nobody can answer any more (a side chat closed or stopped waiting). */
  expire(id: string): void {
    const block = this.deps.repos.blocks.get(id);
    if (block) this.#expire(block);
  }

  /** An action from the app. */
  async act(id: string, input: BlockActionInput): Promise<BlockActionResult> {
    return this.#serial(id, async () => {
      const seen = this.deps.repos.blocks.findAction(input.clientActionId);
      if (seen) {
        if (seen.blockId !== id || seen.action !== input.action)
          throw new DomainError("conflict", "That clientActionId was already used for something else");
        return { block: this.get(id), ...(seen.result ? { result: seen.result } : {}), duplicate: true };
      }
      const block = this.get(id);
      const applied = this.#apply(block, input.action, input.payload, "user");
      const { transition } = applied;
      let result: Record<string, unknown> | undefined;
      let resolution = transition.resolution;

      // Side effects that must succeed before the new state is saved.
      if (block.kind === "secret_request" && input.action === "save") {
        const value = (applied.payload as { value: string }).value;
        const placeholder = this.#saveSecret(block.props as SecretRequestProps, value);
        resolution = { ...resolution, placeholder };
      }
      if (block.kind === "connect_request" && input.action === "connect") {
        const connections = this.deps.connections;
        if (!connections) throw new DomainError("unavailable", "Apps can't be connected from here yet");
        const props = block.props as { app: string; kind: "app" | "custom" };
        const started = await connections.start({ app: props.app, kind: props.kind, blockId: block.id });
        result = { url: started.url };
      }
      if (block.kind === "memory_note" && input.action === "undo") {
        const ref = (block.props as { ref?: string }).ref;
        const memory = this.deps.memory;
        if (ref) {
          if (!memory) throw new DomainError("unavailable", "Memory isn't set up");
          await memory.forget(ref);
        }
      }
      if (block.owner.type === "approval") {
        const decision = approvalDecision(block, transition.state, resolution, transition.props);
        if (decision) {
          const approvals = this.deps.approvals;
          if (!approvals) throw new DomainError("unavailable", "Approvals can't be decided here yet");
          await approvals.decide(block.owner.approvalId, decision);
        }
      }

      const updated = this.#save(block, {
        state: transition.state,
        ...(transition.props ? { props: transition.props } : {}),
        ...(resolution ? { resolution } : {}),
        fallback: applied.fallback,
      });
      if (transition.props) {
        // Re-index the message so Search finds the edited text.
        const message = this.deps.thread.get(updated.messageId);
        if (message) this.deps.thread.saveMessage(message, "updated");
      }
      this.deps.repos.blocks.recordAction({
        clientActionId: input.clientActionId,
        blockId: id,
        action: input.action,
        ...(result ? { result } : {}),
        createdAt: this.deps.clock.now(),
      });
      await this.#afterAction(updated, input.action, input.clientActionId);
      return { block: updated, ...(result ? { result } : {}), duplicate: false };
    });
  }

  /** A server-side transition: a sign-in finished or failed, a need expired. */
  async system(id: string, action: string, payload: unknown = {}): Promise<Block | undefined> {
    return this.#serial(id, async () => {
      const block = this.deps.repos.blocks.get(id);
      if (!block || !canApply(block, action)) return undefined;
      const applied = this.#apply(block, action, payload, "system");
      const updated = this.#save(block, {
        state: applied.transition.state,
        ...(applied.transition.resolution ? { resolution: applied.transition.resolution } : {}),
        fallback: applied.fallback,
      });
      await this.#afterAction(updated, action);
      return updated;
    });
  }

  /** A task ended: its open needs can't be answered any more. */
  expireTask(taskId: string): void {
    for (const block of this.deps.repos.blocks.byTask(taskId)) this.#expire(block);
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  #expire(block: Block): void {
    if (isTerminal(block) || !canApply(block, "expire")) return;
    void this.system(block.id, "expire").catch((error: unknown) => {
      this.deps.log.warn({ err: error, block: block.id }, "couldn't expire a block");
    });
  }

  #apply(block: Block, action: string, payload: unknown, by: "user" | "system") {
    try {
      return applyAction(block, action, payload, by);
    } catch (error) {
      if (!(error instanceof BlockActionError)) throw error;
      const stateConflict = error.message.startsWith("It's already");
      throw new DomainError(stateConflict ? "conflict" : "invalid", error.message);
    }
  }

  #save(block: Block, patch: Partial<Pick<Block, "state" | "props" | "resolution" | "fallback">>): Block {
    const updated: Block = { ...block, ...patch, updatedAt: this.deps.clock.now() };
    this.deps.hub.publish(() => {
      this.deps.repos.blocks.save(updated);
      return [{ type: "block.updated", block: updated }];
    });
    return updated;
  }

  #saveSecret(props: SecretRequestProps, value: string): string {
    const field = SECRET_FIELD[props.secretType];
    const fields = props.fields ?? {};
    const ephemeral = props.ephemeral === true || props.secretType === "code";
    const existing = this.deps.vault.get(props.vaultName);
    if (existing) {
      this.deps.vault.update(props.vaultName, {
        secrets: { [field]: value },
        fields: { ...existing.fields, ...fields },
      });
    } else {
      this.deps.vault.put({
        name: props.vaultName,
        kind: VAULT_KIND[props.secretType],
        fields: { service: props.service, ...fields },
        secrets: { [field]: value },
        description: props.title,
        ephemeral,
        ...(ephemeral ? { expiresAt: this.deps.clock.now() + CODE_TTL_MS } : {}),
      });
    }
    return secretPlaceholder(props);
  }

  /** Tell whoever is waiting: a parked agent, Poke, or the thread (choices). */
  async #afterAction(block: Block, action: string, clientActionId?: string): Promise<void> {
    if (block.kind === "choices" && block.state === "answered") {
      const answer = String(block.resolution?.answer ?? "");
      this.deps.thread.send({
        text: answer,
        clientMessageId: `choice_${clientActionId ?? block.id}`,
        attachmentIds: [],
      });
      return;
    }
    const owner = block.owner;
    if (owner.type === "sidechat") {
      const value = needValue(block);
      if (value) this.#sideChats?.settle(owner.needId, value);
      return;
    }
    if (owner.type === "task") {
      const value = needValue(block);
      if (!value) return;
      await this.deps.agents.resolveNeed(owner.taskId, owner.needId, value).catch((error: unknown) => {
        // The agent stopped waiting: the vault entry is still saved, the app still shows the result.
        this.deps.log.info({ err: error, block: block.id }, "a resolved need had no waiting agent");
      });
      return;
    }
    if (owner.type !== "poke") return;
    const text = pokeNotice(block, action);
    if (!text) return;
    for (const listener of this.#listeners) listener({ block, action, text });
  }

  async #serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.#locks.set(id, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(id) === run) this.#locks.delete(id);
    }
  }
}

/** The value a parked ask_poke call resumes with, once its block is settled. */
function needValue(block: Block): Record<string, unknown> | undefined {
  const r = block.resolution ?? {};
  switch (block.state) {
    case "saved":
      return { status: "saved", vaultName: r.vaultName, placeholder: r.placeholder };
    case "connected":
      return { status: "connected", ...r };
    case "dismissed":
      return { status: "dismissed" };
    case "expired":
      return undefined;
    default:
      return undefined;
  }
}

/** The <block_action> Poke gets for its own blocks. Undefined: nothing to tell. */
function pokeNotice(block: Block, action: string): string | undefined {
  const r = block.resolution ?? {};
  const props = block.props as Record<string, unknown>;
  const title = String(props.title ?? props.kind ?? block.kind);
  let body: string | undefined;
  switch (block.kind) {
    case "action":
      body =
        r.decision === "changed" && r.note ? `changed: ${String(r.note)}` : String(r.decision ?? block.state);
      break;
    case "draft":
      if (action !== "primary") return undefined;
      body = [
        `tapped "${String(r.label ?? "")}". Final text:`,
        props.to ? `To: ${String(props.to)}` : "",
        props.subject ? `Subject: ${String(props.subject)}` : "",
        String(props.body ?? ""),
      ]
        .filter(Boolean)
        .join("\n");
      break;
    case "card": {
      if (action !== "press") return undefined;
      const last = (r.last ?? {}) as { actionId?: string; values?: Record<string, unknown> };
      const values =
        last.values && Object.keys(last.values).length ? `\nvalues: ${JSON.stringify(last.values)}` : "";
      body = `pressed ${String(last.actionId ?? "")}${values}`;
      break;
    }
    case "secret_request":
      if (block.state !== "saved") return undefined;
      body = `saved to the vault as ${String(r.vaultName)}. Use ${String(r.placeholder)} wherever it's needed; it's filled in when a tool runs.`;
      break;
    case "connect_request":
      if (block.state === "connected") body = `connected${r.account ? ` (${String(r.account)})` : ""}`;
      else if (block.state === "dismissed") body = "not now";
      else return undefined;
      break;
    case "memory_note":
      if (block.state !== "undone") return undefined;
      body = `undo: forget "${String(props.text ?? "")}"`;
      break;
    default:
      return undefined;
  }
  return `<block_action block="${block.id}" kind="${block.kind}" title="${title.replace(/"/g, "'")}">\n${body}\n</block_action>`;
}
