import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SystemSecretKey, SystemSecrets } from "@poke/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishMemory, mintHonchoJwt, prepareMemory, renderTemplate } from "./honcho-deploy.js";

class Secrets implements SystemSecrets {
  map = new Map<SystemSecretKey, string>();
  get = (k: SystemSecretKey) => this.map.get(k);
  set = (k: SystemSecretKey, v: string) => void this.map.set(k, v);
  delete = (k: SystemSecretKey) => void this.map.delete(k);
  has = (k: SystemSecretKey) => this.map.has(k);
  keys = () => [...this.map.keys()];
}

const envOf = (text: string) =>
  new Map(
    text
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
  );

let services: string;
beforeEach(() => {
  services = mkdtempSync(join(tmpdir(), "poke-services-"));
});
afterEach(() => rmSync(services, { recursive: true, force: true }));

describe("honcho deploy", () => {
  it("renders values and loops, and refuses anything missing", () => {
    expect(
      renderTemplate("a={{a}}\n{{#xs}}x={{x}}\n{{/xs}}end", { a: 1, xs: [{ x: "p" }, { x: "q" }] }),
    ).toBe("a=1\nx=p\nx=q\nend");
    expect(() => renderTemplate("{{nope}}", {})).toThrow(/nope/);
    expect(() => renderTemplate("{{a}}", { a: "line\nbreak" })).toThrow(/line break/);
  });

  it("mints an admin JWT Honcho can verify (HS256 over {t, ad})", () => {
    const token = mintHonchoJwt("s3cret", Date.UTC(2026, 10, 26));
    const [head, body, sig] = token.split(".");
    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({
      t: "2026-11-26T00:00:00.000Z",
      ad: true,
    });
    expect(sig).toBe(createHmac("sha256", "s3cret").update(`${head}.${body}`).digest("base64url"));
  });

  it("renders Honcho's env with every module on the gateway, keeping secrets across runs", () => {
    const system = new Secrets();
    const layout = prepareMemory({ system, paths: { services } });
    const honcho = readFileSync(layout.honchoEnv, "utf8");
    const compose = readFileSync(layout.composeEnv, "utf8");
    expect(honcho).not.toContain("{{");
    expect(compose).not.toContain("{{");
    const env = envOf(honcho);
    expect(env.get("AUTH_USE_AUTH")).toBe("true");
    expect(env.get("AUTH_JWT_SECRET")).toBe(system.get("honcho.jwtSecret"));
    expect(env.get("LLM_OPENAI_API_KEY")).toBe(system.get("gateway.key"));
    expect(env.get("EMBEDDING_VECTOR_DIMENSIONS")).toBe("1024");
    expect(env.get("EMBEDDING_MODEL_CONFIG__ENCODING_FORMAT_MODE")).toBe("float");
    expect(env.get("DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE")).toBe("json_object");
    const prefixes = [
      "DERIVER",
      "SUMMARY",
      "DREAM_DEDUCTION",
      "DREAM_INDUCTION",
      "EMBEDDING",
      ...["minimal", "low", "medium", "high", "max"].map((l) => `DIALECTIC_LEVELS__${l}_`),
    ];
    for (const prefix of prefixes) {
      expect(env.get(`${prefix}_MODEL_CONFIG__TRANSPORT`)).toBe("openai");
      expect(env.get(`${prefix}_MODEL_CONFIG__OVERRIDES__BASE_URL`)).toBe(
        "http://host.docker.internal:7071/v1",
      );
    }
    const password = system.get("honcho.dbPassword")!;
    expect(env.get("DB_CONNECTION_URI")).toBe(`postgresql+psycopg://honcho:${password}@postgres:5432/honcho`);
    expect(envOf(compose).get("POSTGRES_PASSWORD")).toBe(password);
    if (process.platform !== "win32") expect(statSync(layout.honchoEnv).mode & 0o777).toBe(0o600);

    const before = [...system.map.entries()];
    prepareMemory({ system, paths: { services } });
    expect([...system.map.entries()]).toEqual(before);
    expect(system.has("honcho.jwt")).toBe(false);
  });

  it("defines every variable the compose file uses", () => {
    const layout = prepareMemory({ system: new Secrets(), paths: { services } });
    const used = [...readFileSync(layout.composeFile, "utf8").matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]!);
    const defined = envOf(readFileSync(layout.composeEnv, "utf8"));
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(defined.has(name), name).toBe(true);
  });

  it("turns memory on with a token once Honcho is up", () => {
    const system = new Secrets();
    expect(() => finishMemory(system, 0)).toThrow(/setup first/);
    prepareMemory({ system, paths: { services } });
    finishMemory(system, 0);
    expect(system.get("honcho.jwt")?.split(".")).toHaveLength(3);
  });
});
