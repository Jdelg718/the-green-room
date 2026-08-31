import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrate.js";

const BUSY_TIMEOUT_MILLISECONDS = 5_000;

export interface OpenDatabaseOptions {
  readonly dataDir: string;
  readonly migrationsDir: string;
}

export interface GreenRoomDatabase {
  readonly database: DatabaseSync;
  readonly path: string;
  close(): void;
}

export function openGreenRoomDatabase(options: OpenDatabaseOptions): GreenRoomDatabase {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(options.dataDir, 0o700);

  const path = join(options.dataDir, "greenroom.sqlite");
  const database = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    migrate(database, options.migrationsDir);
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    database,
    path,
    close(): void {
      database.close();
    },
  };
}
