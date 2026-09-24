import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DbClient } from "../../src/db/client.js";

const tempDirs: string[] = [];

function fileDatabasePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "stethoscope-db-"));
  tempDirs.push(dir);
  return path.join(dir, "stethoscope.sqlite");
}

function journalMode(client: DbClient): string {
  const row = client.db.get<{ journal_mode: string }>(sql`PRAGMA journal_mode`);
  return row.journal_mode;
}

function foreignKeysEnabled(client: DbClient): number {
  const row = client.db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`);
  return row.foreign_keys;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("opens a file database with WAL and foreign keys, then closes cleanly", () => {
    const client = openDatabase(fileDatabasePath());

    expect(journalMode(client)).toBe("wal");
    expect(foreignKeysEnabled(client)).toBe(1);

    client.close();

    expect(() => client.db.get(sql`select 1 as value`)).toThrow(/not open/i);
  });

  it("opens an in-memory database and runs a trivial query", () => {
    const client = openDatabase(":memory:");

    expect(foreignKeysEnabled(client)).toBe(1);

    const row = client.db.get<{ value: number }>(sql`select 1 as value`);
    expect(row).toEqual({ value: 1 });

    client.close();
  });
});
