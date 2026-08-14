import type { SemanticModelDocument } from "../semanticModels/schema";
import { getVectorConfig } from "./config";

interface EmbeddingsResponse {
  data?: Array<{ embedding?: unknown; index?: number }>;
}

const SUMMARY_MAX_CHARS = 24_000;

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function summaryText(model: SemanticModelDocument): string {
  const lines: string[] = [
    `model: ${clean(model.model_name)}`,
    `version: ${clean(model.version)}`,
    `domain: ${clean(model.domain)}`,
    `description: ${clean(model.description)}`,
  ];

  for (const entity of model.entities || []) {
    lines.push(
      `entity: ${clean(entity.name)}; table: ${clean(entity.table_name)}; description: ${clean(entity.description)}`,
    );
    for (const dimension of entity.dimensions || []) {
      lines.push(
        `dimension: ${clean(dimension.name)}; column: ${clean(dimension.column_name)}; type: ${clean(dimension.datatype)}; description: ${clean(dimension.description)}`,
      );
    }
    for (const measure of entity.measures || []) {
      lines.push(
        `measure: ${clean(measure.name)}; expression: ${clean(measure.expression)}; aggregation: ${clean(measure.aggregation)}; description: ${clean(measure.description)}`,
      );
    }
  }

  const text = lines.join("\n");
  return text.length <= SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, SUMMARY_MAX_CHARS - 20)}\n[summary truncated]`;
}

export function validateEmbeddingVector(value: unknown, expectedDimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== expectedDimensions) {
    const received = Array.isArray(value) ? value.length : "non-array";
    throw new Error(`Embedding dimension mismatch: expected ${expectedDimensions}, received ${received}`);
  }

  const vector = value.map(Number);
  if (vector.some((number) => !Number.isFinite(number))) {
    throw new Error("Embedding response contains a non-finite value");
  }
  return vector;
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((input) => !clean(input))) {
    throw new Error("Embedding input must contain at least one non-empty string");
  }

  const config = getVectorConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.embeddingsTimeoutMs);

  try {
    const response = await fetch(`${config.embeddingsBaseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.embeddingsModel, input: inputs }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Embeddings request failed (${response.status}): ${detail}`);
    }

    const payload = await response.json() as EmbeddingsResponse;
    if (!Array.isArray(payload.data) || payload.data.length !== inputs.length) {
      throw new Error(`Embeddings response count mismatch: expected ${inputs.length}`);
    }
    return [...payload.data]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((item) => validateEmbeddingVector(item.embedding, config.embeddingsDim));
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`Embeddings request timed out after ${config.embeddingsTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function embedSemanticModel(model: SemanticModelDocument): Promise<number[]> {
  const [vector] = await embedTexts([`search_document: ${summaryText(model)}`]);
  return vector;
}

export async function embedSearchQuery(query: string): Promise<number[]> {
  const [vector] = await embedTexts([`search_query: ${clean(query)}`]);
  return vector;
}

export async function checkEmbeddingsHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    await embedTexts(["search_query: health check"]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
