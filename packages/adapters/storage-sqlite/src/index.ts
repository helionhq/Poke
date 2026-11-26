import type { Repositories } from "@poke/domain";
import { SqliteDb } from "./db.js";
import { migrate } from "./migrations.js";
import { createRepositories } from "./repositories.js";

export { SqliteDb } from "./db.js";
export { MIGRATIONS, migrate } from "./migrations.js";
export { createRepositories, ftsQuery } from "./repositories.js";

export interface PokeDatabase extends Repositories {
  db: SqliteDb;
  close(): void;
  /** Online backup to a file (used before migrations by `poke update`). */
  backup(toPath: string): void;
}

/** Open (and migrate) poke.db. Pass ":memory:" in tests. */
export function openPokeDatabase(path: string): PokeDatabase {
  const db = new SqliteDb(path);
  migrate(db);
  const repos = createRepositories(db);
  return {
    ...repos,
    db,
    close: () => db.close(),
    backup: (toPath: string) => {
      db.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
    },
  };
}
