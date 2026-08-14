import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { SemanticModelDocument } from "../src/semanticModels/schema";
import { embedTexts, validateEmbeddingVector } from "../src/vector/embeddings";
import {
  deleteSemanticModel,
  ensureCollection,
  getQdrantClient,
  retrieveSemanticModel,
  resetQdrantClientForTests,
  searchSemanticModels,
  upsertSemanticModel,
} from "../src/vector/qdrant";
import { resetVectorConfigForTests } from "../src/vector/config";

const TEST_CONNECTION_ID = 2_147_483_000;
const TEST_SEMANTIC_KEY = "vector-selftest-supply-chain";

const model: SemanticModelDocument = {
  version: "1.0",
  model_name: "Vector Selftest Supply Chain",
  domain: "Supply Chain",
  description: "Temporary semantic model used to validate local vector retrieval.",
  datasource: {
    connection_id: TEST_SEMANTIC_KEY,
    database_name: "vector_selftest",
  },
  entities: [{
    name: "Shipment",
    table_name: "shipments",
    description: "Supply chain shipments moving between facilities.",
    primary_keys: ["shipment_id"],
    dimensions: [{
      name: "Destination Region",
      column_name: "destination_region",
      datatype: "varchar",
      description: "Region receiving the shipment.",
    }],
    measures: [{
      name: "Shipment Count",
      expression: "shipment_id",
      aggregation: "count_distinct",
      datatype: "integer",
      format: "number",
      description: "Number of distinct shipments.",
    }],
  }],
  relationships: [],
};

async function main(): Promise<void> {
  let dimensionRejected = false;
  try {
    validateEmbeddingVector([1, 2, 3], 768);
  } catch (error) {
    dimensionRejected = String((error as Error).message).includes("dimension mismatch");
  }
  if (!dimensionRejected) throw new Error("Embedding dimension mismatch was not rejected");

  let nonFiniteRejected = false;
  try {
    validateEmbeddingVector(Array.from({ length: 768 }, (_, index) => index === 12 ? Number.NaN : 0), 768);
  } catch (error) {
    nonFiniteRejected = String((error as Error).message).includes("non-finite");
  }
  if (!nonFiniteRejected) throw new Error("Non-finite embedding value was not rejected");

  const timeoutServer = createServer(() => undefined);
  await new Promise<void>((resolve) => timeoutServer.listen(0, "127.0.0.1", resolve));
  const address = timeoutServer.address();
  const oldEmbeddingsBaseUrl = process.env.EMBEDDINGS_BASE_URL;
  const oldEmbeddingsTimeout = process.env.EMBEDDINGS_TIMEOUT_MS;
  try {
    if (!address || typeof address === "string") throw new Error("Timeout self-test server did not bind");
    process.env.EMBEDDINGS_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    process.env.EMBEDDINGS_TIMEOUT_MS = "50";
    resetVectorConfigForTests();
    let timeoutRejected = false;
    try {
      await embedTexts(["search_query: timeout self-test"]);
    } catch (error) {
      timeoutRejected = String((error as Error).message).includes("timed out");
    }
    if (!timeoutRejected) throw new Error("Embedding timeout was not surfaced deterministically");
  } finally {
    if (oldEmbeddingsBaseUrl === undefined) delete process.env.EMBEDDINGS_BASE_URL;
    else process.env.EMBEDDINGS_BASE_URL = oldEmbeddingsBaseUrl;
    if (oldEmbeddingsTimeout === undefined) delete process.env.EMBEDDINGS_TIMEOUT_MS;
    else process.env.EMBEDDINGS_TIMEOUT_MS = oldEmbeddingsTimeout;
    resetVectorConfigForTests();
    timeoutServer.closeAllConnections?.();
    await new Promise<void>((resolve) => timeoutServer.close(() => resolve()));
  }

  const mismatchCollection = `semantic_mismatch_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const oldCollection = process.env.QDRANT_COLLECTION;
  const cleanupClient = getQdrantClient();
  await cleanupClient.createCollection(mismatchCollection, {
    vectors: { size: 3, distance: "Cosine" },
  });
  try {
    process.env.QDRANT_COLLECTION = mismatchCollection;
    resetVectorConfigForTests();
    resetQdrantClientForTests();
    let mismatchRejected = false;
    try {
      await ensureCollection();
    } catch (error) {
      mismatchRejected = String((error as Error).message).includes("incompatible");
    }
    if (!mismatchRejected) throw new Error("Incompatible Qdrant collection was not rejected");
  } finally {
    if (oldCollection === undefined) delete process.env.QDRANT_COLLECTION;
    else process.env.QDRANT_COLLECTION = oldCollection;
    resetVectorConfigForTests();
    resetQdrantClientForTests();
    await cleanupClient.deleteCollection(mismatchCollection);
  }

  const vectors = await embedTexts([
    "search_document: supply chain shipment model",
    "search_query: shipments by destination region",
  ]);
  if (vectors.length !== 2 || vectors.some((vector) => vector.length !== 768)) {
    throw new Error("Embedding batch did not return two 768-dimensional vectors");
  }
  if (vectors.some((vector) => vector.some((number) => !Number.isFinite(number)))) {
    throw new Error("Embedding batch contains non-finite values");
  }

  await ensureCollection();
  await ensureCollection();
  await deleteSemanticModel(TEST_CONNECTION_ID).catch(() => undefined);

  try {
    await upsertSemanticModel({
      connectionId: TEST_CONNECTION_ID,
      semanticKey: TEST_SEMANTIC_KEY,
      modelRevision: 1,
      model,
      modelUpdatedAt: new Date().toISOString(),
    });
    const retrieved = await retrieveSemanticModel(TEST_CONNECTION_ID);
    if (retrieved?.semantic_key !== TEST_SEMANTIC_KEY || retrieved.model_revision !== 1) {
      throw new Error("Qdrant retrieve did not return the upserted semantic model");
    }

    const matches = await searchSemanticModels("supply chain shipments by destination region", 5);
    if (!matches.some((match) => match.connectionId === TEST_CONNECTION_ID)) {
      throw new Error("Semantic search did not return the expected self-test connection");
    }
  } finally {
    await deleteSemanticModel(TEST_CONNECTION_ID);
  }

  const deleted = await retrieveSemanticModel(TEST_CONNECTION_ID);
  if (deleted !== null) {
    throw new Error("Qdrant delete did not remove the self-test point");
  }
  console.log("[Vector self-test] PASS: dimension/finite/timeout guards, mismatch-safe collection, 768-d embeddings, CRUD, and search");
}

main().catch((error) => {
  console.error(`[Vector self-test] FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
});
