import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@poke/domain";
import pino from "pino";

/**
 * Redaction applied to every log line before it is written. The vault installs the real scrubber
 * (every live secret value + encodings) once it is open; until then, nothing secret is loaded.
 */
export const logRedactor: { scrub: (text: string) => string } = { scrub: (text) => text };

export function createLogger(opts: { logsDir?: string; level?: string; pretty?: boolean } = {}): Logger {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  if (opts.logsDir) {
    mkdirSync(opts.logsDir, { recursive: true });
    streams.push({
      stream: pino.destination({ dest: join(opts.logsDir, "poke.log"), mkdir: true, sync: false }),
    });
  }
  const base = pino(
    {
      level: opts.level ?? process.env.POKE_LOG_LEVEL ?? "info",
      base: { svc: "poke" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ["req.headers.authorization", "headers.authorization", "*.token", "*.apiKey"],
        censor: "[redacted]",
      },
      hooks: {
        streamWrite: (line) => logRedactor.scrub(line),
      },
    },
    pino.multistream(streams),
  );
  return wrap(base);
}

function wrap(logger: pino.Logger): Logger {
  const call =
    (level: "debug" | "info" | "warn" | "error") =>
    (obj: Record<string, unknown> | string, msg?: string): void => {
      if (typeof obj === "string") logger[level](obj);
      else logger[level](obj, msg);
    };
  return {
    debug: call("debug"),
    info: call("info"),
    warn: call("warn"),
    error: call("error"),
    child: (bindings) => wrap(logger.child(bindings)),
  };
}
