import type { AgentActivity, Message } from "@poke/domain";
import type { Kernel } from "./kernel.js";

/** In-flight state a reconnecting client needs (messages still streaming, Poke's activity). */
export interface LiveState {
  streaming(): Message[];
  activity(scope: string): AgentActivity;
}

export const idleLive: LiveState = {
  streaming: () => [],
  activity: () => "idle",
};

/** Everything HTTP/WS handlers can reach. Grows milestone by milestone. */
export interface Services extends Kernel {
  version: string;
  startedAt: number;
  live: LiveState;
}

export function servicesFromKernel(kernel: Kernel, extra: { version: string; live?: LiveState }): Services {
  return { ...kernel, version: extra.version, startedAt: Date.now(), live: extra.live ?? idleLive };
}
