/**
 * WS2 Needle TEXT challenger seam — embedder interface plus deterministic stub.
 *
 * Isolated scope: no network, no model download, no native bridge. The stub
 * produces deterministic finite vectors of `NEEDLE_EMBEDDING_DIM` so matching
 * experiments can run shape-correct comparisons against the USE default
 * without wiring any real model. Real-model wiring lands behind the
 * `embedNeedle` seam in `services/embeddings.ts` in a later step.
 */

/** Challenger embedding width. Fixed so parity checks can assert on it. */
export const NEEDLE_EMBEDDING_DIM = 384;

export const NEEDLE_STUB_MODEL_ID = "needle-text-stub-v0";

const MAX_TEXT_LENGTH = 5000;

/** Minimal challenger embedder contract ( challenger side only ). */
export interface NeedleEmbedder {
  readonly dimension: number;
  readonly modelId: string;
  embedNeedleTexts(texts: string[]): Promise<number[][]>;
}

function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic finite pseudo-vector in [-1, 1] with non-zero norm. */
function stubVector(text: string, dimension: number): number[] {
  const row: number[] = [];
  for (let i = 0; i < dimension; i++) {
    const mixed = hash32(`${text}::${i}`) / 0xffffffff;
    row.push(mixed * 2 - 1);
  }
  const norm = row.reduce((sum, value) => sum + Math.abs(value), 0);
  if (norm === 0) row.push(0.5);
  return row.slice(0, dimension);
}

function assertValidInputs(texts: readonly string[]): void {
  if (texts.length === 0) throw new Error("Invalid needle embedding input");
  for (const text of texts) {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
      throw new Error("Invalid needle embedding input");
    }
  }
}

/**
 * Validates a challenger payload with the same strictness as the USE bridge
 * contract: one vector per input, uniform non-zero dimension, finite numbers
 * only, stable order. Throws instead of fabricating scores.
 */
export function validateNeedleVectors(
  texts: readonly string[],
  vectors: unknown,
  dimension: number = NEEDLE_EMBEDDING_DIM,
): number[][] {
  const invalid = new Error("Invalid needle embedding result");
  if (!Array.isArray(vectors) || vectors.length !== texts.length) throw invalid;
  const rows = vectors.map((row) => {
    if (!Array.isArray(row) || row.length !== dimension || dimension === 0) throw invalid;
    return row.map((component) => {
      if (typeof component !== "number" || !Number.isFinite(component)) throw invalid;
      return component;
    });
  });
  return rows;
}

/** Deterministic stub used for seam shape tests and offline experiments. */
export class StubNeedleEmbedder implements NeedleEmbedder {
  readonly dimension = NEEDLE_EMBEDDING_DIM;
  readonly modelId = NEEDLE_STUB_MODEL_ID;

  async embedNeedleTexts(texts: string[]): Promise<number[][]> {
    assertValidInputs(texts);
    const vectors = texts.map((text) => stubVector(text, this.dimension));
    return validateNeedleVectors(texts, vectors, this.dimension);
  }
}
