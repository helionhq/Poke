import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The vault master key: 32 random bytes in ~/poke/keys/master.key (0600). When the server runs
 * under systemd with LoadCredential=, $CREDENTIALS_DIRECTORY/master.key takes precedence.
 */
export function loadMasterKey(path: string): Uint8Array {
  const credDir = process.env.CREDENTIALS_DIRECTORY;
  const credPath = credDir ? `${credDir}/master.key` : undefined;
  const source = credPath && existsSync(credPath) ? credPath : path;
  const raw = readFileSync(source, "utf8").trim();
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`Master key at ${source} is not 32 bytes`);
  return new Uint8Array(key);
}

export function ensureMasterKey(path: string): { created: boolean } {
  if (existsSync(path)) return { created: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return { created: true };
}
