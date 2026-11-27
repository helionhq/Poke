import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

/** A thin synchronous wrapper over node:sqlite with a statement cache and nested transactions. */
export class SqliteDb {
  readonly raw: DatabaseSync;
  #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.#stmt(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SqlValue[]): T[] {
    return this.#stmt(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      const name = `sp${this.#depth}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      this.#depth++;
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        this.#depth--;
      }
    }
    this.raw.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.#depth--;
    }
  }

  close(): void {
    this.#statements.clear();
    this.raw.close();
  }
}

export const json = (value: unknown): string => JSON.stringify(value ?? null);
export const parse = <T>(value: SqlValue | undefined): T => JSON.parse(String(value ?? "null")) as T;
export const opt = <T>(value: SqlValue | undefined): T | undefined =>
  value === null || value === undefined ? undefined : (value as T);
export const optJson = <T>(value: SqlValue | undefined): T | undefined =>
  value === null || value === undefined ? undefined : (JSON.parse(String(value)) as T);
