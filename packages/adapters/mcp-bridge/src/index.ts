import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  McpCallResult,
  McpConnector,
  McpServerConfig,
  McpSession,
  McpToolInfo,
  ToolOutputItem,
} from "@poke/domain";

const CLIENT_INFO = { name: "poke", version: "0.1.0" };
/** Default deadline for one tool call; browse and Executor pass their own. */
const CALL_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * MCP client for local servers (stdio or streamable HTTP), browse (`browse mcp`) and Executor.
 * Stdio servers inherit only the SDK's short list of safe environment variables (HOME, PATH…)
 * plus their own `env`, so provider keys in Poke's environment never reach them.
 */
export class SdkMcpConnector implements McpConnector {
  async connect(transport: McpServerConfig["transport"], opts: { name?: string } = {}): Promise<McpSession> {
    return connectTransport(makeTransport(transport), opts.name);
  }
}

export function makeTransport(transport: McpServerConfig["transport"]): Transport {
  if (transport.kind === "stdio") {
    return new StdioClientTransport({
      command: transport.command,
      args: transport.args,
      ...(transport.env ? { env: transport.env } : {}),
      stderr: "ignore",
    });
  }
  return new StreamableHTTPClientTransport(new URL(transport.url), {
    ...(transport.headers ? { requestInit: { headers: transport.headers } } : {}),
  });
}

export async function connectTransport(transport: Transport, name = "server"): Promise<McpSession> {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const listeners = new Set<() => void>();
  let closed = false;
  client.onclose = () => {
    if (closed) return;
    closed = true;
    for (const listener of listeners) listener();
  };
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => {});
    throw new Error(`Couldn't reach the ${name} MCP server: ${message(error)}`, { cause: error });
  }
  return {
    async tools() {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema as Record<string, unknown>,
            ...(tool.annotations
              ? {
                  annotations: {
                    ...(tool.annotations.readOnlyHint !== undefined
                      ? { readOnlyHint: tool.annotations.readOnlyHint }
                      : {}),
                    ...(tool.annotations.destructiveHint !== undefined
                      ? { destructiveHint: tool.annotations.destructiveHint }
                      : {}),
                    ...(tool.annotations.idempotentHint !== undefined
                      ? { idempotentHint: tool.annotations.idempotentHint }
                      : {}),
                  },
                }
              : {}),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async call(tool, args, opts = {}) {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: opts.timeoutMs ?? CALL_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return toCallResult(result);
    },
    onClose(listener) {
      listeners.add(listener);
    },
    async close() {
      closed = true;
      await client.close();
    },
  };
}

/** MCP content → Poke tool output. Resources become text; audio is named, not played. */
export function toCallResult(result: Record<string, unknown>): McpCallResult {
  const output: ToolOutputItem[] = [];
  const content = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  for (const item of content) {
    switch (item.type) {
      case "text":
        output.push({ type: "text", text: String(item.text ?? "") });
        break;
      case "image":
        output.push({
          type: "image",
          data: String(item.data ?? ""),
          mimeType: String(item.mimeType ?? "image/png"),
        });
        break;
      case "resource": {
        const resource = (item.resource ?? {}) as Record<string, unknown>;
        const body = typeof resource.text === "string" ? resource.text : "(binary content)";
        output.push({ type: "text", text: `${String(resource.uri ?? "resource")}\n${body}` });
        break;
      }
      case "resource_link":
        output.push({ type: "text", text: `${String(item.name ?? "link")}: ${String(item.uri ?? "")}` });
        break;
      case "audio":
        output.push({ type: "text", text: "(audio content)" });
        break;
      default:
        break;
    }
  }
  // Older servers answer with `toolResult` instead of `content`.
  if (!content.length && "toolResult" in result)
    output.push({ type: "text", text: JSON.stringify(result.toolResult) });
  if (!output.length && result.structuredContent !== undefined)
    output.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  return {
    output,
    ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
    isError: result.isError === true,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
