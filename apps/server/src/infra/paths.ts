import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Everything Poke keeps on its machine lives under ~/poke (override with POKE_HOME). */
export interface PokePaths {
  home: string;
  data: string;
  keys: string;
  workspace: string;
  library: string;
  skills: string;
  services: string;
  run: string;
  logs: string;
  updates: string;
  db: string;
  vaultDb: string;
  durableDb: string;
  masterKey: string;
  adminSocket: string;
  config: string;
}

export function resolvePaths(home = process.env.POKE_HOME ?? join(homedir(), "poke")): PokePaths {
  const root = resolve(home);
  const data = join(root, "data");
  const run = join(root, "run");
  return {
    home: root,
    data,
    keys: join(root, "keys"),
    workspace: join(root, "workspace"),
    library: join(root, "library"),
    skills: join(root, "skills"),
    services: join(root, "services"),
    run,
    logs: join(root, "logs"),
    updates: join(root, "updates"),
    db: join(data, "poke.db"),
    vaultDb: join(data, "vault.db"),
    durableDb: join(data, "durable.sqlite"),
    masterKey: join(root, "keys", "master.key"),
    adminSocket:
      process.platform === "win32"
        ? `\\\\.\\pipe\\poke-admin-${Buffer.from(root).toString("hex").slice(-16)}`
        : join(run, "admin.sock"),
    config: join(root, "config.json"),
  };
}

export const DATA_DIRS = [
  "data",
  "keys",
  "workspace",
  "library",
  "skills",
  "services",
  "run",
  "logs",
  "updates",
] as const;

export function ensureDirs(paths: PokePaths): void {
  for (const dir of DATA_DIRS) {
    mkdirSync(paths[dir], { recursive: true, mode: dir === "keys" || dir === "run" ? 0o700 : 0o755 });
  }
  mkdirSync(join(paths.library, "attachments"), { recursive: true });
}
