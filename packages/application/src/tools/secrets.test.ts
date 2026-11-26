import type { VaultEntry } from "@poke/domain";
import { describe, expect, it } from "vitest";
import { SecretRedactor } from "./redactor.js";
import { envName, SecretResolver, shellPlaceholders } from "./secrets.js";

function fakeVault() {
  const entries: Record<string, VaultEntry & { secrets: Record<string, string> }> = {
    "resy.login": {
      name: "resy.login" as VaultEntry["name"],
      kind: "login",
      fields: { email: "dinners@fastmail.com" },
      secretFields: ["password"],
      secrets: { password: "hunter2-secret" },
      usedBy: [],
      ephemeral: false,
      createdAt: 1,
      updatedAt: 1,
    },
    "resy.code": {
      name: "resy.code" as VaultEntry["name"],
      kind: "code",
      fields: {},
      secretFields: ["code"],
      secrets: { code: "481516" },
      usedBy: [],
      ephemeral: true,
      createdAt: 1,
      updatedAt: 1,
    },
  };
  const used: Array<[string, string | undefined]> = [];
  return {
    used,
    vault: {
      list: () => Object.values(entries),
      get: (name: string) => entries[name],
      resolve: (name: string, field?: string) => {
        const entry = entries[name];
        if (!entry) return undefined;
        if (!field) return Object.values(entry.secrets)[0];
        return entry.secrets[field] ?? entry.fields[field];
      },
      markUsed: (name: string, by?: string) => {
        used.push([name, by]);
        if (entries[name]?.ephemeral) delete entries[name];
      },
    },
  };
}

const agent = { kind: "executor" as const, taskId: "tsk_1" };

describe("SecretResolver", () => {
  it("fills placeholders anywhere in a tool's arguments, and marks entries used afterwards", () => {
    const { vault, used } = fakeVault();
    const resolver = new SecretResolver(vault);
    const prepared = resolver.prepare(
      "executor_call",
      { body: { user: "{{vault:resy.login.email}}", pass: "{{vault:resy.login.password}}" }, n: 3 },
      agent,
      "resy",
    );
    expect(prepared.args).toEqual({ body: { user: "dinners@fastmail.com", pass: "hunter2-secret" }, n: 3 });
    expect(used).toEqual([]);
    prepared.release();
    prepared.release();
    expect(used).toEqual([["resy.login", "resy"]]);
  });

  it("gives a shell environment variables, never the value on the command line", () => {
    const { vault } = fakeVault();
    const prepared = new SecretResolver(vault).prepare(
      "bash",
      { command: "curl -u me:{{vault:resy.login.password}} https://api.resy.com" },
      agent,
    );
    const variable = envName("resy.login.password");
    expect(variable).toBe("POKE_SECRET_RESY_LOGIN_PASSWORD");
    expect(prepared.args).toEqual({ command: `curl -u me:"\${${variable}}" https://api.resy.com` });
    expect(prepared.env).toEqual({ [variable]: "hunter2-secret" });
    expect(JSON.stringify(prepared.args)).not.toContain("hunter2");
  });

  it("refuses unknown, missing and used-up secrets with a message the agent can act on", () => {
    const { vault } = fakeVault();
    const resolver = new SecretResolver(vault);
    expect(() => resolver.prepare("write", { content: "{{vault:github.token}}" }, agent)).toThrow(
      /no vault entry called github.token/,
    );
    expect(() => resolver.prepare("write", { content: "{{vault:resy.login.pin}}" }, agent)).toThrow(
      /has no field pin \(it has: password, email\)/,
    );
    const once = resolver.prepare("write", { content: "{{vault:resy.code}}" }, agent);
    expect(once.args).toEqual({ content: "481516" });
    once.release();
    expect(() => resolver.prepare("write", { content: "{{vault:resy.code}}" }, agent)).toThrow(
      /no vault entry/,
    );
  });

  it("leaves arguments without placeholders untouched", () => {
    const { vault, used } = fakeVault();
    const args = { content: "hello" };
    const prepared = new SecretResolver(vault).prepare("write", args, agent);
    expect(prepared.args).toBe(args);
    prepared.release();
    expect(used).toEqual([]);
  });
});

describe("shellPlaceholders", () => {
  const env = (ref: string) => envName(ref);
  it("expands the variable wherever the placeholder stood, whatever the quoting", () => {
    expect(shellPlaceholders("echo {{vault:a.b}}", env)).toBe('echo "${POKE_SECRET_A_B}"');
    expect(shellPlaceholders('echo "key={{vault:a.b}}"', env)).toBe('echo "key=${POKE_SECRET_A_B}"');
    expect(shellPlaceholders("echo 'key={{vault:a.b}}'", env)).toBe(`echo 'key='"\${POKE_SECRET_A_B}"''`);
    expect(shellPlaceholders(`echo "it's" '"' {{vault:a.b}}`, env)).toBe(
      `echo "it's" '"' "\${POKE_SECRET_A_B}"`,
    );
    expect(shellPlaceholders('echo \\"{{vault:a.b}}', env)).toBe('echo \\""${POKE_SECRET_A_B}"');
  });
});

describe("SecretRedactor", () => {
  it("replaces every form of a secret with its vault name", () => {
    const redactor = new SecretRedactor(() => [
      { name: "resy.login", value: "hunter2-secret" },
      { name: "system", value: "sk-sp-abcdef123456" },
    ]);
    const base64 = Buffer.from("hunter2-secret").toString("base64");
    expect(
      redactor.redact(`pw=hunter2-secret b64=${base64} url=${encodeURIComponent("hunter2-secret")}`),
    ).toBe("pw=[vault:resy.login] b64=[vault:resy.login] url=[vault:resy.login]");
    expect(redactor.redactValue({ key: "Bearer sk-sp-abcdef123456" })).toEqual({
      key: "Bearer [vault:system]",
    });
  });
});
