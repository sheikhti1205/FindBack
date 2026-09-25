import { Capacitor, registerPlugin } from "@capacitor/core";

interface EmbeddingBridge {
  embedTexts(options: { texts: string[] }): Promise<{ vectors: number[][] }>;
}

/**
 * Creates the embedding input string by trimming and joining title and description.
 * Title and description are joined with a newline if both are present.
 */
export function embeddingInput(title: string, description: string): string {
  const trimmedTitle = title.trim();
  const trimmedDescription = description.trim();

  if (trimmedTitle && trimmedDescription) {
    return `${trimmedTitle}\n${trimmedDescription}`;
  }
  return trimmedTitle || trimmedDescription;
}

/**
 * Validates an embedding payload before any cosine scoring (bridge contract:
 * one vector per input, uniform non-zero dimension, finite numbers only, stable
 * order). Throws instead of letting a short/ragged payload fabricate scores.
 * Never echoes the input texts.
 */
export function validateEmbeddingVectors(texts: readonly string[], vectors: unknown): number[][] {
  const invalid = new Error("Invalid embedding result");
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw invalid;
  const rows = vectors.map((row) => {
    if (!Array.isArray(row) || row.length === 0) throw invalid;
    return row.map((component) => {
      if (typeof component !== "number" || !Number.isFinite(component)) throw invalid;
      return component;
    });
  });
  const dimension = rows[0]?.length ?? 0;
  if (rows.some((row) => row.length !== dimension)) throw invalid;
  return rows;
}

/**
 * Embeds texts using the independent non-generative native bridge.
 * Returns validated vectors (number[][]) from the native implementation.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!Capacitor.isNativePlatform()) throw new Error("Embedding unavailable in browser");
  if (texts.length > 21 || texts.some((text) => !text.trim() || text.length > 5000)) {
    throw new Error("Invalid embedding input");
  }
  const { vectors } = await registerPlugin<EmbeddingBridge>("FindBackEmbeddings").embedTexts({ texts });
  return validateEmbeddingVectors(texts, vectors);
}
