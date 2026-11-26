import { createHash } from "node:crypto";
import {
  type ApprovalPresentation,
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
  constructor(private readonly deps: ApprovalsDeps) {}

  /** Expire requests nobody waits on (after a restart, or when their task ends). */
  start(): void {
    for (const request of this.deps.repos.approvals.pending()) {
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
    input: ApprovalInput,
    run: (outcome: ApprovalOutcome) => Promise<ToolResultData> | ToolResultData,
  ): Promise<ToolResultData> {
    if (ctx.resume) {
      const value = (ctx.resume.value ?? {}) as Partial<ApprovalOutcome> & { expired?: boolean };
      if (value.expired || !value.approvalId)
        return text("No decision came in time. Don't retry it; report what's blocked.", true);
      return run({ ...value, allowed: value.allowed === true, approvalId: value.approvalId });
    }
    if (ctx.agent.kind !== "executor")
      throw new DomainError("unavailable", "Only agents can run tools that need an OK");
    const taskId = ctx.agent.taskId;
    const needId = `need_${taskId}_${ctx.callId}`.replace(/[^A-Za-z0-9_]/g, "_");
    const task = this.deps.repos.tasks.get(taskId);
    if (task?.need?.id === needId) return { output: [], park: { needId } }; // a replayed call

    const now = this.deps.clock.now();
    const args = this.deps.redact(input.args);
    const request: ApprovalRequest = {
      id: this.deps.ids.next("apr"),
      integration: input.integration,
      tool: input.tool,
      title: input.title,
      details: input.details ?? [],
      ...(input.reason ? { reason: input.reason } : {}),
      args,
      argsHash: argsHash(input.args),
      resume: input.resume,
      requester: { kind: "task", taskId },
      status: "pending",
      ...(input.presentation ? { presentation: input.presentation } : {}),
      ...(input.offer ? { offer: input.offer } : {}),
      createdAt: now,
    };
    const rule = this.matchingRule(input.integration, input.tool, input.args);
    if (rule) {
      request.status = "allowed";
      request.ruleId = rule.id;
      request.decidedAt = now;
      this.deps.repos.approvals.save(request);
      this.#log(request);
      return run({ allowed: true, approvalId: request.id, ruleId: rule.id });
    }
    this.deps.repos.approvals.save(request);
    this.deps.agents.ask(taskId, { kind: "approval", approvalId: request.id }, needId);
    return { output: [], park: { needId } };
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
      app: request.integration,
      tool: request.tool,
      action: request.title,
      ...(request.details.length ? { details: request.details.slice(0, 10) } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.offer ? { always: request.offer.description } : {}),
    },
  };
}
