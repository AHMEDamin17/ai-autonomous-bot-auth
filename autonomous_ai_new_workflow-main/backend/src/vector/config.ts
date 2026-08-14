import { z } from "zod";

const PositiveInteger = z.coerce.number().int().positive();

const VectorConfigSchema = z.object({
  qdrantUrl: z.string().url(),
  qdrantApiKey: z.string(),
  qdrantCollection: z.string().trim().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  qdrantTimeoutMs: PositiveInteger,
  embeddingsBaseUrl: z.string().url(),
  embeddingsModel: z.string().trim().min(1),
  embeddingsDim: PositiveInteger,
  embeddingsTimeoutMs: PositiveInteger,
});

export type VectorConfig = z.infer<typeof VectorConfigSchema>;

let cachedConfig: VectorConfig | undefined;

export function getVectorConfig(): VectorConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = VectorConfigSchema.parse({
    qdrantUrl: process.env.QDRANT_URL || "http://localhost:6333",
    qdrantApiKey: process.env.QDRANT_API_KEY || "",
    qdrantCollection: process.env.QDRANT_COLLECTION || "semantic_models",
    qdrantTimeoutMs: process.env.QDRANT_TIMEOUT_MS || "10000",
    embeddingsBaseUrl: process.env.EMBEDDINGS_BASE_URL || "http://localhost:11434/v1",
    embeddingsModel: process.env.EMBEDDINGS_MODEL || "nomic-embed-text:v1.5",
    embeddingsDim: process.env.EMBEDDINGS_DIM || "768",
    embeddingsTimeoutMs: process.env.EMBEDDINGS_TIMEOUT_MS || "30000",
  });
  return cachedConfig;
}

export function resetVectorConfigForTests(): void {
  cachedConfig = undefined;
}
