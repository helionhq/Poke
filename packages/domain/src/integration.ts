/**
 * Integrations come from Executor Cloud (third-party apps) and local MCP servers. Executor binds
 * accounts per requirement, so each extra account is a copy of the app ("gmail-work").
 */
export interface Integration {
  /** Executor app id, or `mcp:<server>` for a local MCP server. */
  id: string;
  name: string;
  source: "executor" | "mcp";
  icon?: string;
  category?: string;
  /** "Set up by Poke from the Strava API" */
  custom?: { from: string; toolCount?: number };
  accounts: IntegrationAccount[];
  defaultAccountId?: string;
  /** Poke policy toggles, enforced in the ToolGateway ("Send email: Asks first" is Executor's call). */
  capabilities: CapabilityToggle[];
  connectedAt?: number;
}

export interface IntegrationAccount {
  id: string;
  /** Executor app copy this account is bound to ("gmail", "gmail-work"). */
  appId: string;
  label: string;
  /** e.g. the email address of the connected account (non-secret). */
  identity?: string;
  status: "connected" | "pending" | "error";
}

export interface CapabilityToggle {
  id: string;
  label: string;
  /** Tool-name patterns this toggle covers. */
  tools: string[];
  /** "on": allowed; "off": blocked by Poke policy; "ask": Executor gates it (display only). */
  mode: "on" | "off" | "ask";
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";

/** An Executor-gated call that paused (elicitation, model mode) and waits for a decision. */
export interface ApprovalRequest {
  id: string;
  integration: string;
  tool: string;
  /** Plain-language title ("Refund $84.00 to Maya Chen"). */
  title: string;
  details: Array<{ label: string; value: string }>;
  reason?: string;
  /** Redacted arguments, kept for display; the decision binds to argsHash. */
  args: Record<string, unknown>;
  argsHash: string;
  /** How Executor will be resumed. */
  resume: { executionId: string; source: "executor" };
  /** Which agent is waiting. */
  requester: { kind: "task"; taskId: string } | { kind: "poke" } | { kind: "sidechat"; sideChatId: string };
  status: ApprovalStatus;
  /** Set when an always-allow rule resolved it. */
  ruleId?: string;
  /**
   * The block it is shown as (section 12): a send is a `draft`, a booking or purchase an
   * `action`, anything else a `tool_approval` built from the fields above.
   */
  presentation?: ApprovalPresentation;
  /** The quiet "Always allow …" option, when one makes sense. */
  offer?: { description: string; constraint?: unknown };
  createdAt: number;
  decidedAt?: number;
}

export type ApprovalPresentation =
  { kind: "draft"; props: Record<string, unknown> } | { kind: "action"; props: Record<string, unknown> };

/** "Always allow refunds under $100": Executor-gated tools only. */
export interface ApprovalRule {
  id: string;
  integration: string;
  tool: string;
  /** JSON-logic over the call arguments; absent = always. */
  constraint?: unknown;
  /** Plain words shown in the app. */
  description: string;
  createdAt: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport:
    | { kind: "stdio"; command: string; args: string[]; env?: Record<string, string> }
    | {
        kind: "http";
        url: string;
        headers?: Record<string, string>;
      };
  enabled: boolean;
  toolCount?: number;
  createdAt: number;
}
