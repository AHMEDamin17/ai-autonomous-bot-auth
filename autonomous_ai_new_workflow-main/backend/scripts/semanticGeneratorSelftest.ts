import "dotenv/config";
import type { DatabaseConnection } from "../src/types/types";
import { fetchMetadata } from "../src/routes/semanticLayer/dataCatalog";
import {
  appendTables,
  generateFull,
  regenerateTable,
  removeTable,
  type SemanticAuthor,
} from "../src/semanticModels/generator";
import pool from "../src/db/connection";

async function main(): Promise<void> {
  const connection: DatabaseConnection = {
    id: 0,
    connection_name: "Generator Selftest",
    semantic_key: "mysql_generator_selftest",
    db_type: "mysql",
    host: `${process.env.DB_HOST || "localhost"}:${process.env.DB_PORT || "3306"}`,
    default_schema: process.env.DB_NAME || "autonomous_db",
    db_user: process.env.DB_USER || "root",
    db_password: process.env.DB_PASSWORD || "root",
    created_at: new Date(),
  };
  const metadata = await fetchMetadata(connection);
  const candidates = metadata.tables
    .filter((table) => metadata.columns.some((column) => column.table_name.toLowerCase() === table.table_name.toLowerCase()))
    .slice(0, 4);
  if (candidates.length < 4) throw new Error("Generator self-test requires four catalog tables");

  let overviewCalls = 0;
  let entityCalls = 0;
  const author: SemanticAuthor = {
    async createOverview(context) {
      overviewCalls += 1;
      return {
        model_name: "AutonomousMetadata",
        domain: "Platform",
        description: "Application-aware metadata model.",
        table_roles: context.tables.map((table) => ({
          table_name: table.table_name,
          role: "platform metadata",
          description: `Metadata stored in ${table.table_name}.`,
        })),
      };
    },
    async createEntity(_context, _overview, table) {
      entityCalls += 1;
      return {
        name: `Entity ${table.table_name} ${entityCalls}`,
        description: `Generated entity call ${entityCalls}.`,
        dimensions: table.columns.map((column) => ({
          name: column.column_name,
          column_name: column.column_name,
          description: `Dimension for ${column.column_name}.`,
        })),
        measures: [],
      };
    },
  };

  const initialNames = candidates.slice(0, 3).map((table) => table.table_name);
  const full = await generateFull(connection, initialNames, author);
  if (full.entities.length !== 3 || overviewCalls !== 1 || entityCalls !== 3) {
    throw new Error("Full generation did not create exactly three selected entities with one overview pass");
  }

  const beforeAppendCalls = entityCalls;
  const appended = await appendTables(
    connection,
    [initialNames[0], candidates[3].table_name],
    full,
    author,
  );
  if (appended.entities.length !== 4 || entityCalls !== beforeAppendCalls + 1 || overviewCalls !== 1) {
    throw new Error("Append did not generate only the missing selected table");
  }
  for (const entity of full.entities) {
    const next = appended.entities.find((candidate) => candidate.table_name === entity.table_name);
    if (JSON.stringify(next) !== JSON.stringify(entity)) {
      throw new Error("Append changed an existing entity");
    }
  }

  const beforeRegenerate = new Map(appended.entities.map((entity) => [entity.table_name, JSON.stringify(entity)]));
  const beforeRegenerateCalls = entityCalls;
  const regenerated = await regenerateTable(connection, initialNames[0], appended, author);
  if (entityCalls !== beforeRegenerateCalls + 1) {
    throw new Error("Table regeneration did not make exactly one entity-authoring call");
  }
  for (const entity of regenerated.entities) {
    const previous = beforeRegenerate.get(entity.table_name);
    if (entity.table_name === initialNames[0]) {
      if (JSON.stringify(entity) === previous) throw new Error("Regeneration did not replace the selected entity");
    } else if (JSON.stringify(entity) !== previous) {
      throw new Error("Regeneration changed an unselected entity");
    }
  }

  const callsBeforeRemoval = entityCalls;
  const removed = await removeTable(connection, initialNames[1], regenerated);
  if (entityCalls !== callsBeforeRemoval
    || removed.entities.length !== 3
    || removed.entities.some((entity) => entity.table_name === initialNames[1])) {
    throw new Error("Removal called the author or removed the wrong scope");
  }

  console.log("[Semantic generator self-test] PASS: two-pass full, incremental append/regenerate, and no-LLM removal");
}

main().then(
  async () => {
    await pool.end();
    process.exit(0);
  },
  async (error) => {
    console.error(`[Semantic generator self-test] FAIL: ${(error as Error).message}`);
    await pool.end().catch(() => undefined);
    process.exit(1);
  },
);
