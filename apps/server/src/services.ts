import type { AgentActivity, Message } from "@poke/domain";
import { DomainError } from "@poke/domain";
import type { Kernel } from "./kernel.js";
import type { AgentStack } from "./stack.js";

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
  /** Runtimes, executors, Poke and side chats; absent in tests that only exercise the API core. */
  stack?: AgentStack;
}

export function servicesFromKernel(
  kernel: Kernel,
  extra: { version: string; live?: LiveState; stack?: AgentStack },
): Services {
  return {
    ...kernel,
    version: extra.version,
    startedAt: Date.now(),
    live: extra.live ?? extra.stack?.poke ?? idleLive,
    ...(extra.stack ? { stack: extra.stack } : {}),
  };
}

export function requireStack(services: Services): AgentStack {
  if (!services.stack) throw new DomainError("unavailable", "Poke's agents aren't running");
  return services.stack;
}
