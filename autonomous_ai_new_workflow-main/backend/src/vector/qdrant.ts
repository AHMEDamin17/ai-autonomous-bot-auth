import { QdrantClient } from "@qdrant/js-client-rest";
import type { SemanticModelDocument } from "../semanticModels/schema";
import { getVectorConfig } from "./config";
import { embedSearchQuery, embedSemanticModel } from "./embeddings";

export interface SemanticVectorPayload {
  connection_id: number;
  semantic_key: string;
  model_revision: number;
  model: SemanticModelDocument;
  model_updated_at: string;
  indexed_at: string;
}

export interface SemanticSearchHit {
  connectionId: number;
  semanticKey: string;
  score: number;
  modelRevision: number;
  model: SemanticModelDocument;
}

let client: QdrantClient | undefined;

export function getQdrantClient(): QdrantClient {
  if (client) return client;
  const config = getVectorConfig();
  client = new QdrantClient({
    url: config.qdrantUrl,
    apiKey: config.qdrantApiKey || undefined,
    timeout: config.qdrantTimeoutMs,
    checkCompatibility: false,
  });
  return client;
}

export function resetQdrantClientForTests(): void {
  client = undefined;
}

function readSingleVectorConfig(value: unknown): { size: number; distance: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.size === "number" && typeof candidate.distance === "string") {
    return { size: candidate.size, distance: candidate.distance };
  }
  return null;
}

export async function ensureCollection(): Promise<void> {
  const config = getVectorConfig();
  const qdrant = getQdrantClient();
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((collection) => collection.name === config.qdrantCollection);

  if (!exists) {
    await qdrant.createCollection(config.qdrantCollection, {
      vectors: { size: config.embeddingsDim, distance: "Cosine" },
      on_disk_payload: true,
    });
    return;
  }

  const info = await qdrant.getCollection(config.qdrantCollection);
  const vectorConfig = readSingleVectorConfig(info.config.params.vectors);
  if (!vectorConfig) {
    throw new Error(
      `Qdrant collection ${config.qdrantCollection} does not use the required single unnamed vector configuration`,
    );
  }
  if (vectorConfig.size !== config.embeddingsDim || vectorConfig.distance !== "Cosine") {
    throw new Error(
      `Qdrant collection ${config.qdrantCollection} is incompatible: expected ${config.embeddingsDim}/Cosine, received ${vectorConfig.size}/${vectorConfig.distance}`,
    );
  }
}

export async function upsertSemanticModel(args: {
  connectionId: number;
  semanticKey: string;
  modelRevision: number;
  model: SemanticModelDocument;
  modelUpdatedAt: string;
}): Promise<void> {
  await ensureCollection();
  const config = getVectorConfig();
  const vector = await embedSemanticModel(args.model);
  const payload: SemanticVectorPayload = {
    connection_id: args.connectionId,
    semantic_key: args.semanticKey,
    model_revision: args.modelRevision,
    model: args.model,
    model_updated_at: args.modelUpdatedAt,
    indexed_at: new Date().toISOString(),
  };

  await getQdrantClient().upsert(config.qdrantCollection, {
    wait: true,
    points: [{ id: args.connectionId, vector, payload: payload as unknown as Record<string, unknown> }],
  });
}

export async function retrieveSemanticModel(connectionId: number): Promise<SemanticVectorPayload | null> {
  const config = getVectorConfig();
  const records = await getQdrantClient().retrieve(config.qdrantCollection, {
    ids: [connectionId],
    with_payload: true,
    with_vector: false,
  });
  if (records.length === 0) return null;
  return records[0].payload as unknown as SemanticVectorPayload;
}

export async function deleteSemanticModel(connectionId: number): Promise<void> {
  const config = getVectorConfig();
  await getQdrantClient().delete(config.qdrantCollection, {
    wait: true,
    points: [connectionId],
  });
}

export async function searchSemanticModels(query: string, limit = 5): Promise<SemanticSearchHit[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Semantic search limit must be an integer between 1 and 50");
  }
  await ensureCollection();
  const config = getVectorConfig();
  const vector = await embedSearchQuery(query);
  const matches = await getQdrantClient().query(config.qdrantCollection, {
    query: vector,
    limit,
    with_payload: true,
    with_vector: false,
  });

  return matches.points.map((point) => {
    const payload = point.payload as unknown as SemanticVectorPayload;
    return {
      connectionId: Number(payload.connection_id),
      semanticKey: String(payload.semantic_key),
      score: Number(point.score),
      modelRevision: Number(payload.model_revision),
      model: payload.model,
    };
  });
}

export async function checkQdrantHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getQdrantClient().getCollections();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
