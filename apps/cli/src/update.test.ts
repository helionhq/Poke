import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "@poke/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "./admin.js";
import { looksLikeTunnelToken, resolveServices, writeUnits } from "./commands/services.js";
import { githubSlug, gitAuthEnv, prune, releaseFor } from "./commands/update.js";

describe("poke update helpers", () => {
  it("gives git the token through its environment, for github.com only", () => {
    const env = gitAuthEnv("ghp_secret", { PATH: "/bin" });
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`,
    );
    // Appends after config the caller already set, and without a token adds nothing.
    expect(gitAuthEnv("t", { GIT_CONFIG_COUNT: "2" }).GIT_CONFIG_KEY_2).toBeDefined();
    expect(gitAuthEnv(undefined, {}).GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("reads owner/repo from https and ssh remotes", () => {
    expect(githubSlug("https://github.com/helionhq/Poke.git")).toBe("helionhq/Poke");
    expect(githubSlug("git@github.com:helionhq/Poke.git")).toBe("helionhq/Poke");
    expect(githubSlug("https://github.com/helionhq/Poke")).toBe("helionhq/Poke");
    expect(githubSlug("https://gitlab.com/a/b.git")).toBeUndefined();
  });

  it("finds the release CI made for a fingerprint", () => {
    const fp = "6a8f711c5ad06e51456916c7fac392aefe8f0918";
    const releases = [
      { tag_name: "ios-410-abc1234-000000000000", assets: [] },
      { tag_name: `ios-412-def5678-${fp.slice(0, 12)}`, draft: true, assets: [] },
      { tag_name: `ios-411-0123456-${fp.slice(0, 12)}`, assets: [] },
    ];
    expect(releaseFor(releases, fp)?.tag_name).toBe(`ios-411-0123456-${fp.slice(0, 12)}`);
    expect(releaseFor(releases, "ffffffffffffffff")).toBeUndefined();
  });

  it("prunes old updates by their numeric prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "poke-prune-"));
    for (const name of ["1000-a", "900-b", "20000-c", "3000-d"]) mkdirSync(join(dir, name));
    expect(prune(dir, 2).sort()).toEqual(["1000-a", "900-b"]);
    expect(readdirSync(dir).sort()).toEqual(["20000-c", "3000-d"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("poke start/stop/logs", () => {
  it("maps names and aliases to the server and Docker services", () => {
    expect(resolveServices(undefined)).toBeUndefined();
    expect(resolveServices("poke")).toEqual({ server: true, docker: [] });
    expect(resolveServices("honcho")).toEqual({ server: false, docker: ["honcho-api", "honcho-deriver"] });
    expect(resolveServices("tunnel")).toEqual({ server: false, docker: ["cloudflared"] });
    expect(resolveServices("postgres")).toEqual({ server: false, docker: ["postgres"] });
    expect(() => resolveServices("nginx")).toThrow(/No service called nginx/);
  });

  it("recognizes a remotely managed tunnel token", () => {
    const token = Buffer.from(JSON.stringify({ a: "acct", t: "tunnel-uuid", s: "c2VjcmV0" })).toString(
      "base64",
    );
    expect(looksLikeTunnelToken(token)).toBe(true);
    expect(looksLikeTunnelToken(`  ${token}\n`)).toBe(true);
    expect(looksLikeTunnelToken("not-a-token")).toBe(false);
    expect(looksLikeTunnelToken(Buffer.from("{}").toString("base64"))).toBe(false);
  });
});

describe("systemd units", () => {
  let home: string;
  let xdg: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "poke-units-"));
    xdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(home, "config");
  });
  afterEach(() => {
    if (xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = xdg;
    rmSync(home, { recursive: true, force: true });
  });

  it("renders poke.service for this checkout, user and node", () => {
    const ctx = { paths: resolvePaths(join(home, "poke")) } as Context;
    const written = writeUnits(ctx, join(__dirname, "..", "..", ".."));
    expect(written.map((f) => f.split(/[\\/]/).pop())).toEqual([
      "poke.service",
      "poke-update.service",
      "poke-update.timer",
    ]);
    const unit = readFileSync(written[0]!, "utf8");
    expect(unit).not.toContain("{{");
    expect(unit).toContain(`ExecStart=${process.execPath} `);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain(`Environment=POKE_HOME=${join(home, "poke")}`);
    expect(readFileSync(written[1]!, "utf8")).toContain("update --nightly");
  });
});
