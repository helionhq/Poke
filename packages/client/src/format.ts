import type { Message, Step, Trace } from "@poke/contracts";

/** A long gap that earns its own DayDivider even on the same day. */
export const DIVIDER_GAP_MS = 60 * 60_000;

/** "9:13 AM" in the phone's locale. */
export function clock(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday", "Tuesday" (this week), else "Nov 3" (or "Nov 3, 2025"). */
export function dayLabel(at: number, now = Date.now(), locale?: string): string {
  const d = new Date(at);
  const today = new Date(now);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(today) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return d.toLocaleDateString(locale, { weekday: "long" });
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Whether a DayDivider goes above `current` (first message, new day, or a long gap). */
export function needsDivider(
  previous: Pick<Message, "createdAt"> | undefined,
  current: Pick<Message, "createdAt">,
): boolean {
  if (!previous) return true;
  const a = new Date(previous.createdAt);
  const b = new Date(current.createdAt);
  const otherDay =
    a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
  return otherDay || current.createdAt - previous.createdAt >= DIVIDER_GAP_MS;
}

/** The collapsed trace line: "Used 3 tools" and "Google Calendar, Maps, Resy". */
export function traceSummary(trace: Pick<Trace, "toolCount" | "apps" | "status">): {
  title: string;
  meta?: string;
} {
  const n = trace.toolCount;
  const title = trace.status === "failed" ? "Couldn't finish" : n === 1 ? "Used 1 tool" : `Used ${n} tools`;
  const names = [...new Set(trace.apps.map((a) => a.name))];
  const meta = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  return meta ? { title, meta } : { title };
}

/** What a running trace shows right now: the live line, else the newest running step. */
export function traceLine(trace: Pick<Trace, "line">, steps: readonly Step[], live?: string): string {
  if (live) return live;
  const running = [...steps].reverse().find((s) => s.status === "running");
  return running?.label ?? trace.line ?? "Working on it";
}

/** "12 KB", "3.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Parses `poke://` deep links the app handles. */
export type DeepLink =
  | { kind: "thread"; messageId?: string }
  | { kind: "vault" }
  | { kind: "routine"; id: string }
  | { kind: "pair"; payload: string }
  | { kind: "share" };

export function parseDeepLink(url: string): DeepLink | undefined {
  const m = /^poke:\/\/([a-z]+)(\/[^?#]*)?(\?[^#]*)?/i.exec(url.trim());
  if (!m) return undefined;
  const host = m[1]!.toLowerCase();
  const path = (m[2] ?? "").replace(/^\/+|\/+$/g, "");
  const params = new URLSearchParams((m[3] ?? "").slice(1));
  switch (host) {
    case "thread": {
      const message = params.get("message");
      return message ? { kind: "thread", messageId: message } : { kind: "thread" };
    }
    case "vault":
      return { kind: "vault" };
    case "routines":
      return path ? { kind: "routine", id: decodeURIComponent(path) } : undefined;
    case "pair": {
      const d = params.get("d");
      return d ? { kind: "pair", payload: d } : undefined;
    }
    case "share":
      return { kind: "share" };
    default:
      return undefined;
  }
}
