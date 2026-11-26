import { buildStatus, stackStatus, type StatusReport } from "@poke/server";
import type { Context } from "../admin.js";
import { ago, bad, cmd, dim, ok, pc, printJson, warn } from "../ui.js";

export async function getStatus(ctx: Context): Promise<StatusReport> {
  if (await ctx.online()) return ctx.admin.call<StatusReport>("GET", "/admin/status");
  return buildStatus(ctx.local(), { running: false }, [stackStatus(await ctx.localModels())]);
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export async function statusCommand(ctx: Context, opts: { json?: boolean }): Promise<void> {
  const report = await getStatus(ctx);
  if (opts.json) {
    printJson(report);
    return;
  }
  const out: string[] = [];
  const s = report.server;
  out.push(pc.bold("Poke"));
  out.push(
    s.running
      ? ok(`poke-server ${s.version ?? ""} running ${dim(`· up ${Math.round((s.uptimeSec ?? 0) / 60)} min`)}`)
      : bad(`poke-server is not running ${dim("→")} ${cmd("poke start")}`),
  );
  const services = report.sections.services as Array<{ name: string; state: string }> | undefined;
  if (services)
    for (const svc of services)
      out.push((svc.state === "running" ? ok : warn)(`${svc.name} ${dim(svc.state)}`));
  const logins = report.sections.logins as
    Array<{ id: string; name: string; ok: boolean; note?: string }> | undefined;
  if (logins) {
    out.push("", pc.bold("Logins"));
    for (const l of logins)
      out.push((l.ok ? ok : warn)(`${l.name.padEnd(28)} ${dim(l.note ?? (l.ok ? "logged in" : "not set"))}`));
  }

  out.push("", pc.bold("Models"));
  for (const m of report.models) {
    const a = m.assignment;
    const text = a
      ? `${a.model} · ${a.provider}${a.reasoning ? ` · ${a.reasoning}` : ""}`
      : pc.yellow("not set");
    out.push(`  ${m.label.padEnd(18)} ${text}`);
  }

  if (report.context) {
    const c = report.context;
    const tokens = c.tokens !== undefined ? k(c.tokens) : "—";
    const compacted = c.lastCompaction
      ? ` · compacted ${ago(c.lastCompaction.at)} (${c.lastCompaction.trigger})`
      : "";
    out.push("", `${pc.bold("Context")}  ${tokens} / ${k(c.budget)}${dim(compacted)}`);
  }
  out.push(
    `${pc.bold("Thread")}   ${report.thread.messages} messages${report.thread.since ? dim(` since ${new Date(report.thread.since).toDateString()}`) : ""}`,
  );
  const memory = report.sections.memory as
    { on: boolean; deployed: boolean; gateway: string | null } | undefined;
  if (memory)
    out.push(
      `${pc.bold("Memory")}   ${memory.on ? "on" : pc.yellow(memory.deployed ? "off: Memory models not set" : "not set up")}${memory.gateway ? dim(` · gateway ${memory.gateway}`) : ""}`,
    );
  out.push(`${pc.bold("Devices")}  ${report.devices.active} active`);
  out.push(`${pc.bold("Tasks")}    ${report.tasks.active} running`);
  const due = report.routines.nextDue;
  out.push(
    `${pc.bold("Routines")} ${report.routines.enabled} enabled${due ? dim(` · next: ${due.title} at ${new Date(due.at).toLocaleString()}`) : ""}`,
  );
  if (report.usage.length > 0) {
    out.push("", pc.bold("Usage (7 days)"));
    const totals = new Map<string, { requests: number; input: number; output: number; errors: number }>();
    for (const u of report.usage) {
      const key = `${u.role} · ${u.model}`;
      const t = totals.get(key) ?? { requests: 0, input: 0, output: 0, errors: 0 };
      t.requests += u.requests;
      t.input += u.input;
      t.output += u.output;
      t.errors += u.errors;
      totals.set(key, t);
    }
    for (const [key, t] of totals) {
      out.push(
        `  ${key.padEnd(40)} ${t.requests} req · ${k(t.input)} in · ${k(t.output)} out${t.errors ? pc.red(` · ${t.errors} errors`) : ""}`,
      );
    }
  }
  const errors = report.sections.errors as string[] | undefined;
  if (errors) for (const e of errors) out.push(warn(e));
  console.log(out.join("\n"));
}
