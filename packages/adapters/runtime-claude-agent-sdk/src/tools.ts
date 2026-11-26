import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentRef, ToolInterceptor, ToolInvoker, ToolResultData, ToolSpec } from "@poke/domain";
import { z } from "zod";

export const MCP_SERVER = "poke";
export const mcpName = (name: string) => `mcp__${MCP_SERVER}__${name}`;
export const fromMcpName = (name: string) => name.replace(/^mcp__poke__/, "");

/** zod raw shape for a ToolSpec's JSON Schema (the SDK's tool() takes a shape, not a schema). */
export function shapeOf(spec: ToolSpec): z.ZodRawShape {
  const schema = z.fromJSONSchema(spec.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  if (schema instanceof z.ZodObject) return schema.shape as z.ZodRawShape;
  throw new Error(`${spec.name}: tool input must be an object schema`);
}

type CallToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

function toCallResult(result: ToolResultData, redact: (text: string) => string): CallToolResult {
  if (result.park) {
    return {
      content: [{ type: "text", text: "This tool can't wait for an answer in this conversation." }],
      isError: true,
    };
  }
  const content = result.output.map((item) =>
    item.type === "text" ? { type: "text" as const, text: redact(item.text) } : item,
  );
  return {
    content: content.length ? content : [{ type: "text", text: "" }],
    ...(result.isError ? { isError: true } : {}),
  };
}

export interface ToolBridge {
  agent: AgentRef;
  invoker: ToolInvoker;
  interceptor: ToolInterceptor;
  /** Aborted when the turn is interrupted. */
  signal(): AbortSignal;
}

/** Poke's ToolSpecs as an in-process MCP server (`mcp__poke__<name>`). */
export function pokeMcpServer(specs: ToolSpec[], bridge: ToolBridge): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: MCP_SERVER,
    version: "1.0.0",
    tools: specs.map((spec) =>
      tool(
        spec.name,
        spec.description,
        shapeOf(spec),
        async (args, extra) => {
          const callId = (extra as { _meta?: { "claudecode/toolUseId"?: string } } | undefined)?._meta?.[
            "claudecode/toolUseId"
          ];
          try {
            const result = await bridge.invoker.invoke(spec.name, args, {
              agent: bridge.agent,
              callId: callId ?? `${spec.name}:${Date.now()}`,
              signal: bridge.signal(),
            });
            return toCallResult(result, bridge.interceptor.redact);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { content: [{ type: "text", text: bridge.interceptor.redact(message) }], isError: true };
          }
        },
        {
          alwaysLoad: spec.loading === "always",
          ...(spec.searchHint ? { searchHint: spec.searchHint } : {}),
        },
      ),
    ),
  });
}
