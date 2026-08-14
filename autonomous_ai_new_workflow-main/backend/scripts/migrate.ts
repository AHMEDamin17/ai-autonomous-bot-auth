import * as path from "node:path";
import dotenv from "dotenv";
import type { RowDataPacket } from "mysql2";
import pool from "../src/db/connection";
import { runMigrations } from "./lib/migrationRunner";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function ensureEntraUserColumns(): Promise<void> {
  const [columns] = await pool.query<RowDataPacket[]>(
    `SELECT column_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'users'
        AND column_name IN ('entra_oid', 'password_hash')`,
  );
  const byName = new Map(
    columns.map((row) => [String(row.column_name || row.COLUMN_NAME), String(row.is_nullable || row.IS_NULLABLE)]),
  );

  if (!byName.has("entra_oid")) {
    console.log("PATCH users: add entra_oid");
    await pool.query(
      `ALTER TABLE users
         ADD COLUMN entra_oid VARCHAR(64) NULL AFTER username,
         ADD UNIQUE KEY uq_users_entra_oid (entra_oid)`,
    );
  }

  if (byName.has("password_hash")) {
    console.log("PATCH users: remove legacy password_hash column");
    await pool.query("ALTER TABLE users DROP COLUMN password_hash");
  }
}

async function main() {
  await runMigrations(pool, path.resolve(__dirname, "../migrations"));
  await ensureEntraUserColumns();
  console.log("Done.");
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
