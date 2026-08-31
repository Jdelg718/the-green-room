import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { withImmediateTransaction } from "./transaction.js";

interface Migration {
  readonly checksum: string;
  readonly name: string;
  readonly sql: string;
  readonly version: number;
}

interface AppliedMigration {
  readonly checksum: string;
  readonly name: string;
  readonly version: number;
}

function loadMigrations(directory: string): readonly Migration[] {
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = /^(\d{4})-([a-z0-9-]+)\.sql$/.exec(entry.name);
      if (match === null) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }

      const version = Number(match[1]);
      const sql = readFileSync(join(directory, entry.name), "utf8");
      return {
        checksum: createHash("sha256").update(sql).digest("hex"),
        name: entry.name,
        sql,
        version,
      };
    })
    .sort((left, right) => left.version - right.version);

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (migration === undefined || migration.version !== index + 1) {
      throw new Error("Migrations must be numbered consecutively starting at 0001");
    }
  }

  return migrations;
}

function ensureMigrationTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version >= 1),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT
  `);
}

export function migrate(database: DatabaseSync, migrationsDirectory: string): void {
  const migrations = loadMigrations(migrationsDirectory);
  ensureMigrationTable(database);

  const applied = database
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as unknown as AppliedMigration[];

  for (let index = 0; index < applied.length; index += 1) {
    const recorded = applied[index];
    if (recorded === undefined || recorded.version !== index + 1) {
      throw new Error("Database migration history is not a consecutive prefix");
    }
    const expected = migrations.find(({ version }) => version === recorded.version);
    if (expected === undefined) {
      throw new Error(`Database contains unknown newer migration ${recorded.version}`);
    }
    if (recorded.name !== expected.name) {
      throw new Error(`Name mismatch for migration ${recorded.version}`);
    }
    if (recorded.checksum !== expected.checksum) {
      throw new Error(`Checksum mismatch for migration ${recorded.version}`);
    }
  }

  const appliedVersions = new Set(applied.map(({ version }) => version));
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    try {
      withImmediateTransaction(database, () => {
        database.exec(migration.sql);
        database
          .prepare(
            "INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, migration.checksum);
      });
    } catch (error) {
      throw new Error(`Failed to apply migration ${migration.version}`, { cause: error });
    }
  }
}
