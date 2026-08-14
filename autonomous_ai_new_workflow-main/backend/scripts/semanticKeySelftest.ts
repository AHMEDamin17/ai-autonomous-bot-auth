import "dotenv/config";

import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import pool from "../src/db/connection";
import { semanticKeyBase, semanticKeyCandidate } from "../src/connections/semanticKey";

async function main(): Promise<void> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  let userId = 0;
  const connectionIds: number[] = [];
  try {
    const base = semanticKeyBase("MySQL", "Finance Warehouse");
    if (base !== "mysql_finance_warehouse") throw new Error("Semantic-key normalization changed");
    const collisionKey = semanticKeyCandidate(base);
    if (collisionKey === base || !collisionKey.startsWith(`${base}_`)) {
      throw new Error("Semantic-key collision candidate is not stable and unique");
    }

    const [userResult] = await pool.query<ResultSetHeader>(
      "INSERT INTO users (username, role, is_active) VALUES (?, 'admin', 1)",
      [`semantic_key_selftest_${suffix}`],
    );
    userId = userResult.insertId;
    await pool.query("UPDATE users SET created_by = id, updated_by = id WHERE id = ?", [userId]);

    for (const [name, key] of [["Finance Warehouse", base], ["Finance Warehouse Copy", collisionKey]]) {
      const [result] = await pool.query<ResultSetHeader>(
        `INSERT INTO db_connections
           (connection_name, semantic_key, db_type, host, default_schema, db_user,
            db_password, created_by, updated_by)
         VALUES (?, ?, 'mysql', '127.0.0.1:3306', 'autonomous_db', 'selftest', NULL, ?, ?)`,
        [name, key, userId, userId],
      );
      connectionIds.push(result.insertId);
    }

    await pool.query(
      "UPDATE db_connections SET connection_name = ?, updated_by = ? WHERE id = ?",
      ["Renamed Finance Warehouse", userId, connectionIds[0]],
    );
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT semantic_key, created_by, updated_by FROM db_connections WHERE id = ?",
      [connectionIds[0]],
    );
    if (rows[0]?.semantic_key !== base
      || Number(rows[0]?.created_by) !== userId
      || Number(rows[0]?.updated_by) !== userId) {
      throw new Error("Connection rename changed the semantic key or lost audit stamps");
    }
    console.log("[Semantic key self-test] PASS: normalization, collision suffix, rename stability, and audit stamps");
  } finally {
    for (const connectionId of connectionIds) {
      await pool.query("DELETE FROM db_connections WHERE id = ?", [connectionId]).catch(() => undefined);
    }
    if (userId) {
      await pool.query("UPDATE users SET created_by = NULL, updated_by = NULL WHERE id = ?", [userId]).catch(() => undefined);
      await pool.query("DELETE FROM users WHERE id = ?", [userId]).catch(() => undefined);
    }
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[Semantic key self-test] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
