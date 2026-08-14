import "dotenv/config";

import * as path from "node:path";
import mysql from "mysql2/promise";
import { assertCurrentSchema, inspectCurrentSchema } from "./lib/currentSchema";
import { runMigrations } from "./lib/migrationRunner";

const temporaryDatabase = `autonomous_baseline_selftest_${Date.now()}`;
if (!/^autonomous_baseline_selftest_\d+$/.test(temporaryDatabase)) {
  throw new Error("Invalid temporary baseline database name");
}

async function main(): Promise<void> {
  const connectionOptions = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };
  const admin = await mysql.createConnection(connectionOptions);
  try {
    await admin.query(`CREATE DATABASE \`${temporaryDatabase}\``);
    const db = mysql.createPool({ ...connectionOptions, database: temporaryDatabase });
    try {
      const result = await runMigrations(
        db,
        path.resolve(__dirname, "../migrations"),
      );
      if (result.applied.join(",") !== "001_init.sql") {
        throw new Error(`Expected only 001_init.sql, applied: ${result.applied.join(", ")}`);
      }
      const inspection = await inspectCurrentSchema(db);
      assertCurrentSchema(inspection);
    } finally {
      await db.end();
    }
    console.log("[Schema baseline self-test] PASS: fresh database matches the current runtime schema");
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS \`${temporaryDatabase}\``);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Schema baseline self-test failed");
  process.exitCode = 1;
});
