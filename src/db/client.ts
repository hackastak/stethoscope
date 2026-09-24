import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

/** File-less SQLite path used by tests. WAL is not available for this path. */
export const MEMORY_DATABASE_PATH = ":memory:";

export type AppDatabase = BetterSQLite3Database;

export type DbClient = {
  readonly databasePath: string;
  readonly db: AppDatabase;
  close(): void;
};

/**
 * Open a SQLite database at `databasePath` (or `:memory:`) and return a Drizzle client.
 * File databases use WAL; every connection enforces foreign keys.
 */
export function openDatabase(databasePath: string): DbClient {
  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  if (databasePath !== MEMORY_DATABASE_PATH) {
    sqlite.pragma("journal_mode = WAL");
  }

  const db = drizzle(sqlite);

  return {
    databasePath,
    db,
    close() {
      sqlite.close();
    },
  };
}
