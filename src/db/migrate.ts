import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { AppDatabase } from "./client.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../drizzle",
);

/** Apply pending SQL migrations. Safe to call on every boot — already-applied files are skipped. */
export function migrateDatabase(db: AppDatabase): void {
  migrate(db, { migrationsFolder });
}
