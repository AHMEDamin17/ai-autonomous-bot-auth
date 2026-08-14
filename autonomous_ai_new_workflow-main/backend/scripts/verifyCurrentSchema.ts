import "dotenv/config";

import pool from "../src/db/connection";
import { assertCurrentSchema, inspectCurrentSchema } from "./lib/currentSchema";

async function main(): Promise<void> {
  const inspection = await inspectCurrentSchema(pool);
  console.log(JSON.stringify(inspection, null, 2));
  assertCurrentSchema(inspection);
  console.log("[Current schema] PASS: one baseline migration and only runtime tables/columns remain");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Current schema verification failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
