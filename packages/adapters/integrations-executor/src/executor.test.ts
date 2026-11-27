import { SdkMcpConnector } from "@poke/mcp-bridge";
import { FAKE_MCP_SERVER } from "@poke/mcp-bridge/testing";
import { silentLogger } from "@poke/domain";
import { afterAll, describe, expect, it } from "vitest";
import { ExecutorClient, executorUrl, parseCatalog, parseOutcome } from "./index.js";

const client = new ExecutorClient({
  connector: new SdkMcpConnector(),
  token: () => undefined,
  org: () => undefined,
  log: silentLogger,
  transport: {
    kind: "stdio",
    command: process.execPath,
    args: [FAKE_MCP_SERVER],
    env: { FAKE_MODE: "executor" },
  },
});
afterAll(() => client.close());

describe("executor client", () => {
  it("always connects in model mode", () => {
    expect(executorUrl("north wind")).toBe(
      "https://mcp.executor.sh/org/north%20wind/mcp?elicitation_mode=model",
    );
    const unset = new ExecutorClient({
      connector: new SdkMcpConnector(),
      token: () => "tok",
      org: () => undefined,
      log: silentLogger,
    });
    expect(unset.configured()).toBe(false);
  });

  it("passes plain results through and reads a paused call", async () => {
    const search = await client.run("search", { query: "refund" });
    expect(search.status).toBe("completed");
    const ok = await client.run("call", {
      calls: { path: "tools.github.issues.list", input: { repo: "poke" } },
    });
    expect(ok).toMatchObject({ status: "completed" });
    const paused = await client.run("call", {
      calls: { path: "tools.stripe.refunds.create", input: { amount: 8400, charge: "ch_1" } },
    });
    expect(paused).toMatchObject({
      status: "approval-required",
      requestId: "apr_11111111-1111-1111-1111-111111111111",
      app: "stripe",
      tool: "refunds.create",
      kind: "mutation",
      input: { amount: 8400, charge: "ch_1" },
    });
    const resumed = await client.resume("apr_11111111-1111-1111-1111-111111111111", { action: "accept" });
    expect(resumed).toMatchObject({ status: "completed" });
    expect(JSON.stringify(resumed)).toContain("refunded");
    const again = await client.resume("apr_11111111-1111-1111-1111-111111111111", { action: "accept" });
    expect(again).toMatchObject({ status: "unavailable", reason: "answered" });
  });

  it("starts and checks an account connection", async () => {
    expect(await client.connect("gmail")).toEqual({
      url: "https://executor.sh/connect/abc",
      connectionId: "con_1",
    });
    expect(await client.connection("con_1")).toEqual({ status: "completed", account: "maya@northwind.co" });
  });

  it("reads errors and the catalog", () => {
    expect(parseOutcome({ output: [{ type: "text", text: "boom" }], isError: true })).toEqual({
      status: "other",
      text: "boom",
      isError: true,
    });
    expect(parseOutcome({ output: [], structured: { status: "busy" }, isError: false })).toMatchObject({
      status: "other",
      isError: true,
    });
    const apps = parseCatalog(
      {
        version: 1,
        apps: [
          {
            id: "gmail",
            name: "Gmail",
            category: "email",
            icons: [{ src: "icons/abc.svg" }],
            auth: [{ method: "oauth", kind: "oauth2" }],
          },
          { name: "no id" },
        ],
      },
      "https://catalog.executor.sh/index.json",
    );
    expect(apps).toEqual([
      {
        id: "gmail",
        name: "Gmail",
        category: "email",
        icon: "https://catalog.executor.sh/icons/abc.svg",
        auth: [{ method: "oauth", kind: "oauth2" }],
      },
    ]);
  });
});
