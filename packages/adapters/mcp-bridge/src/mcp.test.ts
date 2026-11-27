import { describe, expect, it } from "vitest";
import { SdkMcpConnector, toCallResult } from "./index.js";
import { FAKE_MCP_SERVER as FAKE_SERVER } from "./testing.js";

describe("mcp bridge", () => {
  it("lists and calls a stdio server's tools, passing only its own env", async () => {
    process.env.POKE_TEST_LEAK = "should-not-pass";
    const session = await new SdkMcpConnector().connect(
      { kind: "stdio", command: process.execPath, args: [FAKE_SERVER], env: { FAKE_TOKEN: "t0k" } },
      { name: "fake" },
    );
    try {
      const tools = await session.tools();
      expect(tools.map((t) => t.name).sort()).toEqual(["echo", "fail"]);
      expect(tools.find((t) => t.name === "echo")?.annotations?.readOnlyHint).toBe(true);
      const ok = await session.call("echo", { text: "hi" });
      expect(ok).toEqual({ output: [{ type: "text", text: "echo: hi t0k" }], isError: false });
      expect((await session.call("fail", {})).isError).toBe(true);
    } finally {
      await session.close();
      delete process.env.POKE_TEST_LEAK;
    }
  });

  it("explains a server that can't start", async () => {
    await expect(
      new SdkMcpConnector().connect(
        { kind: "stdio", command: "poke-no-such-binary", args: [] },
        { name: "ghost" },
      ),
    ).rejects.toThrow(/ghost MCP server/);
  });

  it("turns resources and structured content into text", () => {
    expect(
      toCallResult({ content: [{ type: "resource", resource: { uri: "file:///a.txt", text: "hello" } }] })
        .output,
    ).toEqual([{ type: "text", text: "file:///a.txt\nhello" }]);
    const structured = toCallResult({ content: [], structuredContent: { a: 1 } });
    expect(structured.output).toEqual([{ type: "text", text: '{"a":1}' }]);
    expect(structured.structured).toEqual({ a: 1 });
  });
});
