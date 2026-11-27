import type { McpServerConfig } from "@poke/domain";

/**
 * browse (section 11.3): the relay runs on the server bound to the Tailscale IP
 * (`browse set hostname <tailscale-ip>`, `browse serve` as a systemd user service). Executors
 * reach it through `browse mcp` over stdio, which exposes `execute`, `tabs` and `status`.
 */
export function browseServer(command = "browse"): McpServerConfig["transport"] {
  return { kind: "stdio", command, args: ["mcp"] };
}

export interface BrowseStatus {
  connected: boolean;
  /** What to do when no browser is connected, in browse's words. */
  nextStep?: string;
}

/** Reads `status`'s JSON (`{connected, nextStep, extension: {browsers}}`); unknown shapes count as connected. */
export function parseBrowseStatus(text: string): BrowseStatus {
  try {
    const value = JSON.parse(text) as { connected?: unknown; nextStep?: unknown };
    const nextStep = typeof value.nextStep === "string" && value.nextStep ? value.nextStep : undefined;
    return { connected: value.connected !== false, ...(nextStep ? { nextStep } : {}) };
  } catch {
    return { connected: true };
  }
}
