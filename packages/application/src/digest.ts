import { type Message, messageText, type Repositories, type Task } from "@poke/domain";

export interface DigestOptions {
  userName: string;
  timezone: string;
  /** Upper bound for the whole digest, in characters (~4 per token). */
  maxChars?: number;
  /** Honcho's peer card (milestone 7). */
  memoryCard?: string;
}

/**
 * First-turn context for a session that can't be resumed (first boot, a switch to another
 * runtime, a lost session): the last compaction summary, the recent turns verbatim, and what's
 * still open. The thread itself stays whole in poke.db; search_thread reaches the rest.
 */
export function buildDigest(
  repos: Pick<Repositories, "messages" | "compactions" | "tasks">,
  options: DigestOptions,
): string | undefined {
  const maxChars = options.maxChars ?? 60_000;
  const summary = repos.compactions.latest("poke")?.summary;
  const recent = repos.messages.recent(60).filter((m) => m.scope === "main");
  const active = repos.tasks.active();
  if (!summary && recent.length === 0 && active.length === 0 && !options.memoryCard) return undefined;

  const sections: string[] = [];
  if (summary) sections.push(`<summary>\n${summary.trim()}\n</summary>`);
  if (options.memoryCard)
    sections.push(
      `<about_${tag(options.userName)}>\n${options.memoryCard.trim()}\n</about_${tag(options.userName)}>`,
    );
  if (active.length) sections.push(`<running_agents>\n${active.map(taskLine).join("\n")}\n</running_agents>`);

  const fixed = sections.join("\n\n").length + 200;
  const budget = Math.max(2_000, maxChars - fixed);
  const lines: string[] = [];
  let used = 0;
  for (const message of [...recent].reverse()) {
    const line = messageLine(message, options);
    if (!line) continue;
    if (used + line.length > budget) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  if (lines.length) sections.push(`<recent_messages>\n${lines.join("\n")}\n</recent_messages>`);

  return [
    "<thread_digest>",
    `This conversation continues an earlier session that can't be resumed. Here is where things stand; search_thread finds anything older.`,
    "",
    sections.join("\n\n"),
    "</thread_digest>",
  ].join("\n");
}

function tag(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "user";
}

function taskLine(task: Task): string {
  const need = task.need?.kind === "question" ? ` — waiting for an answer: ${task.need.question}` : "";
  return `- ${task.name} (${task.id}, ${task.status}): ${task.goal}${need}`;
}

function messageLine(message: Message, options: DigestOptions): string | undefined {
  const text = messageText(message).trim();
  const attachments = message.parts.filter((p) => p.type === "attachment").length;
  if (!text && attachments === 0) return undefined;
  const who = message.role === "user" ? options.userName : message.role === "poke" ? "Poke" : "System";
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: options.timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(message.createdAt);
  const extra = attachments ? ` [${attachments} attachment${attachments === 1 ? "" : "s"}]` : "";
  return `[${when}] ${who}: ${text}${extra}`;
}
