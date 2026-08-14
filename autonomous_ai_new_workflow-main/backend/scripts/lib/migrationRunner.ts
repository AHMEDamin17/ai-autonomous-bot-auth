import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Pool, PoolConnection } from "mysql2/promise";

type MigrationQueryable = Pick<Pool, "query"> | Pick<PoolConnection, "query">;

export interface MigrationLogger {
  info(message: string): void;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
}

const defaultLogger: MigrationLogger = {
  info(message) {
    console.log(message);
  },
};

/**
 * Keep the project's existing migration-file contract: SQL files are ordered
 * lexicographically and contain simple top-level statements separated by `;`.
 * Procedure bodies and semicolons inside SQL strings are intentionally unsupported.
 */
export function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  return (await fs.readdir(migrationsDir))
    .filter((file) => file.toLowerCase().endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));
}

export function defaultMigrationsDir(): string {
  return path.resolve(__dirname, "../../migrations");
}

export async function runMigrations(
  db: MigrationQueryable,
  migrationsDir = defaultMigrationsDir(),
  logger: MigrationLogger = defaultLogger,
): Promise<MigrationRunResult> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(191) PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const result: MigrationRunResult = { applied: [], skipped: [] };
  for (const file of await listMigrationFiles(migrationsDir)) {
    const [rows] = await db.query<any[]>(
      "SELECT COUNT(*) AS applied FROM schema_migrations WHERE version = ?",
      [file],
    );
    if (Number(rows[0]?.applied ?? 0) > 0) {
      logger.info(`SKIP ${file}`);
      result.skipped.push(file);
      continue;
    }

    logger.info(`APPLY ${file}`);
    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    for (const statement of splitMigrationStatements(sql)) {
      await db.query(statement);
    }
    await db.query("INSERT INTO schema_migrations (version) VALUES (?)", [file]);
    result.applied.push(file);
  }

  return result;
}

