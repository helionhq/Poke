import { describe, expect, it } from "vitest";
import { gatedInput, integrationsSummary } from "./integrations.js";

describe("Poke's connected apps", () => {
  it("lists connected accounts and MCP servers", () => {
    expect(integrationsSummary([], [])).toBeUndefined();
    expect(
      integrationsSummary(
        [
          {
            id: "gmail",
            name: "Gmail",
            source: "executor",
            defaultAccountId: "c1",
            capabilities: [],
            accounts: [
              { id: "c1", appId: "gmail", label: "arham@me.com", status: "connected" },
              { id: "c2", appId: "gmail-work", label: "arham@work.co", status: "connected" },
            ],
          },
          { id: "stripe", name: "Stripe", source: "executor", capabilities: [], accounts: [] },
        ],
        [
          {
            id: "linear",
            name: "Linear",
            transport: { kind: "http", url: "https://mcp.linear.app/mcp" },
            enabled: true,
            toolCount: 12,
            createdAt: 1,
          },
        ],
      ),
    ).toBe("- Gmail: arham@me.com (default), arham@work.co\n- Linear (MCP server, 12 tools)");
  });
});

const paused = (app: string, tool: string, input: Record<string, unknown>) => ({
  status: "approval-required" as const,
  requestId: "apr_1",
  app,
  tool,
  input,
  message: "Approve?",
});

describe("how a paused Executor call is shown", () => {
  it("shows a send as a draft with the message in it", () => {
    const input = gatedInput(
      paused("gmail", "messages.send", { to: ["maya@northwind.co"], subject: "Refund", body: "Hi Maya" }),
      "Send the refund email to Maya",
    );
    expect(input.presentation).toEqual({
      kind: "draft",
      props: {
        kind: "Email",
        to: "maya@northwind.co",
        subject: "Refund",
        body: "Hi Maya",
        primary: { label: "Send from Gmail" },
      },
    });
    expect(input.offer).toBeUndefined();
    expect(input.resume).toEqual({ executionId: "apr_1", source: "executor" });
  });

  it("shows a booking as an action card and anything else as a tool approval", () => {
    const booking = gatedInput(
      paused("resy", "createBooking", { venue: "Lilia", time: "20:15", party: { size: 2 } }),
      "Book Lilia for 2 at 8:15pm Friday",
    );
    expect(booking.presentation).toMatchObject({
      kind: "action",
      props: {
        kind: "Book",
        title: "Book Lilia for 2 at 8:15pm Friday",
        confirm: "Book",
        change: "Change",
        details: [
          { label: "Venue", value: "Lilia" },
          { label: "Time", value: "20:15" },
          { label: "Party Size", value: "2" },
        ],
      },
    });
    const refund = gatedInput(paused("stripe", "refunds.create", { amount: 8400 }));
    expect(refund.presentation).toBeUndefined();
    expect(refund).toMatchObject({
      integration: "stripe",
      tool: "refunds.create",
      title: "Stripe: refunds create",
      reason: "Stripe asks for an OK before this one.",
      offer: { description: "Always allow refunds.create in Stripe" },
    });
    // A "send" without any text to show is a plain approval, not an empty draft.
    expect(gatedInput(paused("slack", "send_reaction", { emoji: "+1" })).presentation).toBeUndefined();
  });
});
