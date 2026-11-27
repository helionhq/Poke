import { createHash } from "node:crypto";
import {
  type AgentRef,
  type ApprovalPresentation,
  type BlockOwner,
  type ApprovalRequest,
  type ApprovalRule,
  type Clock,
  DomainError,
  type IdGenerator,
  type Logger,
  type Repositories,
  type ToolCallContext,
  type ToolResultData,
} from "@poke/domain";
import type { AgentsService } from "./agents.js";
import type { ApprovalDecider, ApprovalDecision } from "./blocks.js";
import type { EventHub } from "./core/hub.js";
import { evaluateLogic, isLogic } from "./logic.js";
import { text } from "./tools/gateway.js";

const EDITED_TTL_MS = 10 * 60_000;

/** A gated call as Executor paused it (milestone 6 fills this in from the elicitation). */
export interface ApprovalInput {
  integration: string;
  tool: string;
  /** Plain-language title ("Refund $84.00 to Maya Chen"). */
  title: string;
  details?: Array<{ label: string; value: string }>;
  reason?: string;
  args: Record<string, unknown>;
  resume: { executionId: string; source: "executor" };
  presentation?: ApprovalPresentation;
  /** "Always allow refunds under $100", with the JSON-logic it stands for. */
  offer?: { description: string; constraint?: unknown };
}

/** How a gated call ended up: what the tool does next is its own business. */
export interface ApprovalOutcome {
  allowed: boolean;
  approvalId: string;
  /** Allowed by an always-allow rule, without asking. */
  ruleId?: string;
  /** The user's note when they asked for a change instead. */
  note?: string;
  /** A draft the user edited before sending: the final fields. */
  final?: Record<string, unknown>;
  /** The paused call's reference (Executor's requestId), set once it's decided. */
  executionId?: string;
}

/** What a side chat offers a gated call: a card in the chat, and a wait for the decision. */
export interface SideChatCards {
  show(
    sideChatId: string,
    input: { kind: string; props: Record<string, unknown>; owner: BlockOwner },
  ): { id: string };
  wait(sideChatId: string, key: string, blockId?: string): Promise<unknown>;
  settle(key: string, value: unknown): void;
}

/** Whose edited drafts go through once without a second OK: a task, or a side chat. */
export function approvalKey(agent: AgentRef): string | undefined {
  return agent.kind === "executor"
    ? agent.taskId
    : agent.kind === "sidechat"
      ? `sidechat:${agent.sideChatId}`
      : undefined;
}

export interface ApprovalsDeps {
  repos: Repositories;
  ids: IdGenerator;
  clock: Clock;
  log: Logger;
  hub: EventHub;
  agents: Pick<AgentsService, "ask" | "resolveNeed">;
  /** Redacts secrets from the arguments kept for display. */
  redact<T>(value: T): T;
}

/**
 * Approvals (section 12). Poke gates nothing by itself: only a call Executor paused for an OK
 * comes here. An always-allow rule that matches lets it through at once; otherwise the agent parks
 * on an `approval` need, the server shows the matching block under Poke's reply, and the decision
 * (from that block) resumes the agent. Every decision is logged with a hash of the arguments.
 */
export class ApprovalService implements ApprovalDecider {
  #edited: Array<{ taskId: string; integration: string; tool: string; values: string[]; until: number }> = [];

  #sideChats: SideChatCards | undefined;

  constructor(private readonly deps: ApprovalsDeps) {}

  /** Side chats show their approvals in the chat itself (set once they exist). */
  attachSideChats(sideChats: SideChatCards): void {
    this.#sideChats = sideChats;
  }

  /** Expire requests nobody waits on (after a restart, or when their task ends). */
  start(): void {
    for (const request of this.deps.repos.approvals.pending()) {
      // Side chats don't outlive the server.
      if (request.requester.kind === "sidechat") this.#expire(request);
      if (request.requester.kind !== "task") continue;
      const task = this.deps.repos.tasks.get(request.requester.taskId);
      const need = task?.need;
      if (need?.kind !== "approval" || need.approvalId !== request.id) this.#expire(request);
    }
    this.deps.hub.subscribe((frame) => {
      if (frame.kind !== "event") return;
      const event = frame.stored.event;
      if (event.type !== "task.updated" && event.type !== "task.completed") return;
      if (event.task.status === "running" || event.task.status === "waiting") return;
      for (const request of this.deps.repos.approvals.pending())
        if (request.requester.kind === "task" && request.requester.taskId === event.task.id)
          this.#expire(request);
    });
  }

  #expire(request: ApprovalRequest): void {
    request.status = "expired";
    request.decidedAt = this.deps.clock.now();
    this.deps.repos.approvals.save(request);
    this.#log(request);
  }

  /**
   * Wrap a gated call. Returns `park` the first time (unless a rule allows it) and, once decided,
   * whatever `run` returns for the outcome. `run` resumes or declines the paused call.
   */
  async gate(
    ctx: ToolCallContext,
    input: ApprovalInput | undefined,
    run: (outcome: ApprovalOutcome) => Promise<ToolResultData> | ToolResultData,
  ): Promise<ToolResultData> {
    if (ctx.resume) {
      const value = (ctx.resume.value ?? {}) as Partial<ApprovalOutcome> & { expired?: boolean };
      if (value.expired || !value.approvalId)
        return text("No decision came in time. Don't retry it; report what's blocked.", true);
      const decided = this.deps.repos.approvals.get(value.approvalId);
      return run({
        ...value,
        allowed: value.allowed === true,
        approvalId: value.approvalId,
        ...(decided ? { executionId: decided.resume.executionId } : {}),
      });
    }
    if (!input) throw new DomainError("invalid", "Nothing to approve");
    const agent = ctx.agent;
    const key = approvalKey(agent);
    if (agent.kind === "poke" || !key)
      throw new DomainError("unavailable", "Only agents and side chats can run tools that need an OK");
    const taskId = agent.kind === "executor" ? agent.taskId : undefined;
    const needId = `need_${taskId ?? key}_${ctx.callId}`.replace(/[^A-Za-z0-9_]/g, "_");
    if (taskId && this.deps.repos.tasks.get(taskId)?.need?.id === needId)
      return { output: [], park: { needId } }; // a replayed call

    const now = this.deps.clock.now();
    // Executor saw the filled-in call, so every field it describes it with can hold a secret.
    const shown = this.deps.redact({
      title: input.title,
      details: input.details ?? [],
      reason: input.reason,
      args: input.args,
      presentation: input.presentation,
      offer: input.offer,
    });
    const request: ApprovalRequest = {
      id: this.deps.ids.next("apr"),
      integration: input.integration,
      tool: input.tool,
      title: shown.title,
      details: shown.details,
      ...(shown.reason ? { reason: shown.reason } : {}),
      args: shown.args,
      argsHash: argsHash(input.args),
      resume: input.resume,
      requester:
        agent.kind === "executor"
          ? { kind: "task", taskId: agent.taskId }
          : { kind: "sidechat", sideChatId: agent.sideChatId },
      status: "pending",
      ...(shown.presentation ? { presentation: shown.presentation } : {}),
      ...(shown.offer ? { offer: shown.offer } : {}),
      createdAt: now,
    };
    if (this.#takeEdited(key, input)) {
      request.status = "allowed";
      request.decidedAt = now;
      this.deps.repos.approvals.save(request);
      this.#log(request);
      return run({ allowed: true, approvalId: request.id, executionId: input.resume.executionId });
    }
    const rule = this.matchingRule(input.integration, input.tool, input.args);
    if (rule) {
      request.status = "allowed";
      request.ruleId = rule.id;
      request.decidedAt = now;
      this.deps.repos.approvals.save(request);
      this.#log(request);
      return run({
        allowed: true,
        approvalId: request.id,
        ruleId: rule.id,
        executionId: input.resume.executionId,
      });
    }
    this.deps.repos.approvals.save(request);
    if (agent.kind === "sidechat") return this.#inSideChat(agent.sideChatId, request, run);
    this.deps.agents.ask(agent.taskId, { kind: "approval", approvalId: request.id }, needId);
    return { output: [], park: { needId } };
  }

  /** A side chat waits in its tool call: the card goes in the chat, the decision settles the wait. */
  async #inSideChat(
    sideChatId: string,
    request: ApprovalRequest,
    run: (outcome: ApprovalOutcome) => Promise<ToolResultData> | ToolResultData,
  ): Promise<ToolResultData> {
    const sideChats = this.#sideChats;
    if (!sideChats) throw new DomainError("unavailable", "Side chats can't ask for an OK here");
    const block = sideChats.show(sideChatId, {
      ...approvalBlock(request),
      owner: { type: "approval", approvalId: request.id },
    });
    const outcome = (await sideChats.wait(sideChatId, request.id, block.id)) as ApprovalOutcome | undefined;
    if (!outcome) {
      if (this.deps.repos.approvals.get(request.id)?.status === "pending") this.#expire(request);
      return text("No decision came in time. Don't retry it; report what's blocked.", true);
    }
    return run({ ...outcome, executionId: request.resume.executionId });
  }

  /**
   * Arham edited a draft before tapping Send, but Executor resumes a paused call only as it was.
   * The call is declined and the agent sends the edited text again; that one call goes through
   * without a second OK when it carries every edited value, for the same tool, within 10 minutes.
   */
  allowEdited(taskId: string, integration: string, tool: string, values: string[]): void {
    const now = this.deps.clock.now();
    this.#edited = this.#edited.filter((e) => e.until > now);
    this.#edited.push({ taskId, integration, tool, values, until: now + EDITED_TTL_MS });
  }

  #takeEdited(taskId: string, input: ApprovalInput): boolean {
    const now = this.deps.clock.now();
    const serialized = JSON.stringify(input.args);
    const index = this.#edited.findIndex(
      (e) =>
        e.until > now &&
        e.taskId === taskId &&
        e.integration === input.integration &&
        e.tool === input.tool &&
        e.values.every((v) => serialized.includes(JSON.stringify(v).slice(1, -1))),
    );
    if (index < 0) return false;
    this.#edited.splice(index, 1);
    return true;
  }

  /** The first always-allow rule for this tool whose constraint holds for these arguments. */
  matchingRule(integration: string, tool: string, args: Record<string, unknown>): ApprovalRule | undefined {
    return this.deps.repos.approvals.rules().find((rule) => {
      if (rule.integration !== integration || rule.tool !== tool) return false;
      if (rule.constraint === undefined) return true;
      try {
        return evaluateLogic(rule.constraint, args) === true;
      } catch {
        return false; // a rule that can't be read never allows anything
      }
    });
  }

  /** From the block: allowed or denied, maybe with "always", a note or an edited draft. */
  async decide(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const request = this.deps.repos.approvals.get(approvalId);
    if (!request) throw new DomainError("not_found", "Approval not found");
    if (request.status !== "pending") throw new DomainError("conflict", `It's already ${request.status}`);
    request.status = decision.allowed ? "allowed" : "denied";
    request.decidedAt = this.deps.clock.now();
    if (decision.allowed && decision.always && request.offer) {
      const rule = this.addRule({
        integration: request.integration,
        tool: request.tool,
        description: request.offer.description,
        ...(request.offer.constraint !== undefined ? { constraint: request.offer.constraint } : {}),
      });
      request.ruleId = rule.id;
    }
    this.deps.repos.approvals.save(request);
    this.#log(request);
    if (request.requester.kind === "sidechat") {
      this.#sideChats?.settle(approvalId, {
        allowed: decision.allowed,
        approvalId,
        ...(request.ruleId ? { ruleId: request.ruleId } : {}),
        ...(decision.note ? { note: decision.note } : {}),
        ...(decision.final ? { final: decision.final } : {}),
      } satisfies ApprovalOutcome);
      return;
    }
    if (request.requester.kind !== "task") return;
    const task = this.deps.repos.tasks.get(request.requester.taskId);
    const need = task?.need;
    if (!task || need?.kind !== "approval" || need.approvalId !== approvalId) return;
    const outcome: ApprovalOutcome = {
      allowed: decision.allowed,
      approvalId,
      ...(request.ruleId ? { ruleId: request.ruleId } : {}),
      ...(decision.note ? { note: decision.note } : {}),
      ...(decision.final ? { final: decision.final } : {}),
    };
    await this.deps.agents.resolveNeed(task.id, need.id, outcome);
  }

  addRule(input: Omit<ApprovalRule, "id" | "createdAt">): ApprovalRule {
    if (input.constraint !== undefined && !isLogic(input.constraint))
      throw new DomainError("invalid", "That rule's condition can't be read");
    const rule: ApprovalRule = { ...input, id: this.deps.ids.next("rul"), createdAt: this.deps.clock.now() };
    this.deps.repos.approvals.saveRule(rule);
    return rule;
  }

  rules(): ApprovalRule[] {
    return this.deps.repos.approvals.rules();
  }

  deleteRule(id: string): void {
    if (!this.deps.repos.approvals.deleteRule(id)) throw new DomainError("not_found", "Rule not found");
  }

  pending(): ApprovalRequest[] {
    return this.deps.repos.approvals.pending();
  }

  #log(request: ApprovalRequest): void {
    this.deps.repos.approvals.logDecision({
      approvalId: request.id,
      decision: request.status,
      argsHash: request.argsHash,
      ...(request.ruleId ? { ruleId: request.ruleId } : {}),
      at: request.decidedAt ?? this.deps.clock.now(),
    });
  }
}

/** sha256 of the arguments with keys sorted, so the same call always hashes the same. */
export function argsHash(args: unknown): string {
  return createHash("sha256").update(stableJson(args)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The block an approval is shown as (section 12). */
export function approvalBlock(request: ApprovalRequest): { kind: string; props: Record<string, unknown> } {
  if (request.presentation) return request.presentation;
  return {
    kind: "tool_approval",
    props: {
      app: displayName(request.integration),
      tool: request.tool,
      action: request.title,
      ...(request.details.length ? { details: request.details.slice(0, 10) } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.offer ? { always: request.offer.description } : {}),
    },
  };
}

/** "google-calendar" → "Google Calendar", as the ToolApproval shows the app. */
function displayName(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
