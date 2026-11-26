import { ALL_ROLES, type ModelAssignment, type Role, ROLE_LABELS } from "@poke/domain";
import type { Kernel } from "./kernel.js";

export interface StatusReport {
  server: { running: boolean; version?: string; uptimeSec?: number; url?: string };
  thread: { messages: number; since?: number; latestSeq: number };
  devices: { active: number; total: number };
  models: Array<{ role: Role; label: string; assignment?: ModelAssignment }>;
  context?: { tokens?: number; budget: number; lastCompaction?: { trigger: string; at: number } };
  tasks: { active: number };
  routines: { enabled: number; nextDue?: { title: string; at: number } };
  usage: Array<{
    role: string;
    provider: string;
    model: string;
    requests: number;
    input: number;
    output: number;
    errors: number;
  }>;
  /** Filled by later milestones (services, logins, tunnel…). */
  sections: Record<string, unknown>;
}

export type StatusContributor = (report: StatusReport) => void | Promise<void>;

const contributors: StatusContributor[] = [];
export function registerStatus(contributor: StatusContributor): void {
  contributors.push(contributor);
}

export async function buildStatus(
  kernel: Kernel,
  server: StatusReport["server"],
  extra: StatusContributor[] = [],
): Promise<StatusReport> {
  const devices = kernel.db.devices.list();
  const info = kernel.thread.info();
  const routines = kernel.db.routines.list().filter((r) => r.enabled);
  const next = routines
    .filter((r) => r.nextRunAt !== undefined)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  const session = kernel.db.sessions.get("poke");
  const compaction = kernel.db.compactions.latest("poke");
  const day = new Date(kernel.clock.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const report: StatusReport = {
    server,
    thread: {
      messages: info.messageCount,
      latestSeq: kernel.hub.latestSeq(),
      ...(info.since ? { since: info.since } : {}),
    },
    devices: { active: devices.filter((d) => d.revokedAt === undefined).length, total: devices.length },
    models: ALL_ROLES.map((role) => {
      const assignment = kernel.db.models.get(role);
      return { role, label: ROLE_LABELS[role], ...(assignment ? { assignment } : {}) };
    }),
    context: {
      budget: kernel.settings.context().window,
      ...(session?.contextTokens !== undefined ? { tokens: session.contextTokens } : {}),
      ...(compaction ? { lastCompaction: { trigger: compaction.trigger, at: compaction.createdAt } } : {}),
    },
    tasks: { active: kernel.db.tasks.active().length },
    routines: {
      enabled: routines.length,
      ...(next?.nextRunAt !== undefined ? { nextDue: { title: next.title, at: next.nextRunAt } } : {}),
    },
    usage: kernel.db.usage.since(day).map((u) => ({
      role: u.role,
      provider: u.provider,
      model: u.model,
      requests: u.requests,
      input: u.input,
      output: u.output,
      errors: u.errors,
    })),
    sections: {},
  };
  for (const contribute of [...contributors, ...extra]) {
    try {
      await contribute(report);
    } catch (error) {
      report.sections.errors = [...((report.sections.errors as string[]) ?? []), (error as Error).message];
    }
  }
  return report;
}
