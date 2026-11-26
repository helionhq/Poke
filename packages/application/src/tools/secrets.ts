import {
  type AgentRef,
  DomainError,
  parsePlaceholderRef,
  VAULT_PLACEHOLDER_RE,
  type VaultPort,
} from "@poke/domain";

export interface PreparedCall {
  args: unknown;
  /** Extra environment for a shell: placeholders become `$POKE_SECRET_…` variables. */
  env?: Record<string, string>;
  /** Call after the tool ran: marks entries used and wipes one-time codes. */
  release(): void;
}

/** Tools whose `command` runs in a shell; their placeholders become environment variables. */
const SHELL_TOOLS = new Set(["bash", "Bash"]);

interface Resolved {
  ref: string;
  name: string;
  value: string;
  env: string;
}

/**
 * The SecretResolver (section 10): `{{vault:name.field}}` placeholders in a tool call's
 * arguments become values just before the tool runs, inside the executor, never in the
 * transcript. A shell command gets environment variables instead of values, so the secret isn't
 * on the command line. An unknown or expired placeholder fails the call with a clear message.
 */
export class SecretResolver {
  constructor(private readonly vault: Pick<VaultPort, "list" | "get" | "resolve" | "markUsed">) {}

  /** Whether a value holds any placeholder. */
  static has(value: unknown): boolean {
    return JSON.stringify(value ?? null).includes("{{vault:");
  }

  prepare(tool: string, args: unknown, _agent: AgentRef, by?: string): PreparedCall {
    if (!SecretResolver.has(args)) return { args, release: () => {} };
    const used = new Map<string, Resolved>();
    const names = new Set(this.vault.list().map((entry) => entry.name));
    const lookup = (ref: string): Resolved => {
      const seen = used.get(ref);
      if (seen) return seen;
      const resolved = this.#resolve(ref, names);
      used.set(ref, resolved);
      return resolved;
    };
    let prepared: unknown;
    let env: Record<string, string> | undefined;
    const command = (args as { command?: unknown } | null)?.command;
    if (SHELL_TOOLS.has(tool) && typeof command === "string") {
      const rewritten = shellPlaceholders(command, (ref) => lookup(ref).env);
      env = Object.fromEntries([...used.values()].map((r) => [r.env, r.value]));
      prepared = { ...(args as object), command: rewritten };
    } else {
      prepared = replaceDeep(args, (text) =>
        text.replace(placeholderRe(), (_m, ref: string) => lookup(ref).value),
      );
    }
    let released = false;
    return {
      args: prepared,
      ...(env ? { env } : {}),
      release: () => {
        if (released) return;
        released = true;
        for (const name of new Set([...used.values()].map((r) => r.name))) this.vault.markUsed(name, by);
      },
    };
  }

  #resolve(ref: string, names: ReadonlySet<string>): Resolved {
    const { name, field } = parsePlaceholderRef(ref, names);
    const entry = this.vault.get(name);
    if (!entry) {
      throw new DomainError(
        "not_found",
        `There's no vault entry called ${name}. Ask Poke for it with ask_poke (kind "secret").`,
      );
    }
    if (field && !entry.secretFields.includes(field) && !(field in entry.fields)) {
      const fields = [...entry.secretFields, ...Object.keys(entry.fields)].join(", ");
      throw new DomainError("not_found", `${name} has no field ${field} (it has: ${fields}).`);
    }
    const value = this.vault.resolve(name, field);
    if (value === undefined) {
      throw new DomainError(
        "unavailable",
        `${name} can't be used: it expired or was already used once. Ask Poke for a new one.`,
      );
    }
    return { ref, name, value, env: envName(ref) };
  }
}

function placeholderRe(): RegExp {
  return new RegExp(VAULT_PLACEHOLDER_RE.source, "g");
}

/** `resy.login.password` → `POKE_SECRET_RESY_LOGIN_PASSWORD`. */
export function envName(ref: string): string {
  return `POKE_SECRET_${ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Rewrite placeholders in a shell command into variable references that expand wherever the
 * placeholder stood: `"${VAR}"` outside quotes, `${VAR}` inside double quotes, and `'"${VAR}"'`
 * inside single quotes (close, expand, reopen). Quoted heredocs (`<<'EOF'`) don't expand
 * variables; agents are told to use a plain `<<EOF` or an env var there.
 */
export function shellPlaceholders(command: string, envFor: (ref: string) => string): string {
  const re = placeholderRe();
  let out = "";
  let quote: "none" | "single" | "double" = "none";
  let i = 0;
  while (i < command.length) {
    re.lastIndex = i;
    const match = command.startsWith("{{vault:", i) ? re.exec(command) : null;
    if (match && match.index === i) {
      const ref = `\${${envFor(match[1]!)}}`;
      out += quote === "double" ? ref : quote === "single" ? `'"${ref}"'` : `"${ref}"`;
      i += match[0].length;
      continue;
    }
    const ch = command[i]!;
    if (ch === "\\" && quote !== "single") {
      out += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "'" && quote !== "double") quote = quote === "single" ? "none" : "single";
    else if (ch === '"' && quote !== "single") quote = quote === "double" ? "none" : "double";
    out += ch;
    i += 1;
  }
  return out;
}

function replaceDeep(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return value.includes("{{vault:") ? fn(value) : value;
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceDeep(v, fn)]));
  }
  return value;
}
