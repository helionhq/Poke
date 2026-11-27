// A tiny MCP server for tests. FAKE_MODE=executor answers like Executor in elicitation_mode=model.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "1.0.0" });
const reply = (structured) => ({
  content: [{ type: "text", text: JSON.stringify(structured) }],
  structuredContent: structured,
});

if (process.env.FAKE_MODE === "executor") {
  const answered = new Set();
  server.registerTool("search", { inputSchema: { query: z.string().optional() } }, ({ query }) =>
    reply({ items: [{ path: "tools.stripe.refunds.create", description: `refunds (${query})` }] }),
  );
  server.registerTool("call", { inputSchema: { calls: z.any() } }, ({ calls }) => {
    const call = Array.isArray(calls) ? calls[0] : calls;
    if (call.path.endsWith("refunds.create"))
      return reply({
        status: "approval-required",
        requestId: "apr_11111111-1111-1111-1111-111111111111",
        invocation: {
          app: "stripe",
          owner: "o",
          version: "1",
          tool: "refunds.create",
          kind: "mutation",
          input: call.input,
          accounts: {},
        },
        elicitation: {
          mode: "form",
          message: "Approve refunds.create?\n\nArguments: {}",
          requestedSchema: { type: "object", properties: {} },
        },
        expiresAt: Date.now() + 900_000,
      });
    return reply({
      status: "completed",
      execution: { results: [{ ok: true, value: { echoed: call.input } }] },
    });
  });
  server.registerTool("execute", { inputSchema: { code: z.string() } }, ({ code }) => {
    if (code.includes("userConnect"))
      return reply({
        status: "completed",
        execution: {
          result: {
            connection: { id: "con_1", state: { status: "pending" } },
            url: "https://executor.sh/connect/abc",
          },
        },
      });
    if (code.includes("accountConnections.get"))
      return reply({
        status: "completed",
        execution: {
          result: {
            id: "con_1",
            state: { status: "completed", account: { id: "acc_1", name: "maya@northwind.co" } },
          },
        },
      });
    return reply({ status: "completed", execution: { result: code.length } });
  });
  server.registerTool(
    "resume",
    {
      inputSchema: {
        requestId: z.string(),
        response: z.object({ action: z.string(), content: z.any().optional() }),
      },
    },
    ({ requestId, response }) => {
      if (answered.has(requestId))
        return reply({ status: "unavailable", requestId, reason: "answered", message: "Already answered" });
      answered.add(requestId);
      if (response.action === "accept")
        return reply({
          status: "completed",
          execution: { results: [{ ok: true, value: { refunded: true } }] },
        });
      return reply({
        status: "completed",
        execution: { results: [{ ok: false, error: "declined by the user" }] },
      });
    },
  );
  server.registerTool("skills", { inputSchema: { app: z.string().optional() } }, () => reply({ skills: [] }));
  server.registerTool("describe", { inputSchema: { paths: z.array(z.string()) } }, ({ paths }) =>
    reply({ items: paths }),
  );
} else {
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    ({ text }) => ({
      content: [
        {
          type: "text",
          text: `echo: ${text} ${process.env.FAKE_TOKEN ?? ""} ${process.env.POKE_TEST_LEAK ?? ""}`.trim(),
        },
      ],
    }),
  );
  server.registerTool("fail", { inputSchema: {} }, () => ({
    content: [{ type: "text", text: "nope" }],
    isError: true,
  }));
}

await server.connect(new StdioServerTransport());
