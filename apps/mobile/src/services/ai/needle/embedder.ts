/**
 * Needle TEXT challenger seam — embedder interface, deterministic stub for
 * shape tests, and the native-backed production embedder.
 *
 * The stub produces deterministic finite vectors of `NEEDLE_EMBEDDING_DIM`
 * so matching experiments can run shape-correct comparisons against the USE
 * default without wiring any real model. Production injects
 * `NativeNeedleEmbedder` (backed by the `FindbackNeedle` JNI bridge over
 * the pinned needle3 engine) via `setNeedleEmbedder` in
 * `services/embeddings.ts`; the stub never serves production traffic.
 */

/** Challenger embedding width. Fixed so parity checks can assert on it. */
export const NEEDLE_EMBEDDING_DIM = 384;

export const NEEDLE_STUB_MODEL_ID = "needle-text-stub-v0";

/**
 * Pinned production Needle model (Cactus needle3, Apache-2.0).
 * Revision + content SHA mirror `scripts/fetch-needle-model.mjs` and the
 * `needle3-cact-l20` catalogue profile. The embedding width is discovered
 * from the engine at bring-up (`needle_embed` null-output probe) — the
 * constant above stays the test/stub contract until the probe result is
 * wired through (never assumed from `hidden_size`).
 */
export const NEEDLE_MODEL_ID = "needle3-cact-l20";
export const NEEDLE_MODEL_REVISION = "c7c415a3d1b3d929014bc6e866d51ebb971f7089";
export const NEEDLE_MODEL_SHA256 =
  "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38";
export const NEEDLE_MODEL_BYTES = 35335380;

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

/**
 * Native bridge surface for one embed call. Implemented by the
 * `FindbackNeedle` Capacitor plugin (JNI over the pinned engine);
 * faked in tests. Rejects while the engine or weights are absent — never
 * falls back to the stub (stub vectors must never mix with real ones).
 */
export interface NativeNeedleBridge {
  readonly bridgeName: string;
  /** Engine + weights loaded and embedding dimension probed. */
  isNeedleAvailable(): Promise<boolean>;
  /** Live embedding width from the engine null-output probe. */
  embeddingDimension(): Promise<number>;
  embedNeedleTexts(texts: string[]): Promise<number[][]>;
}

/**
 * Production embedder over the native Needle engine. Validates every
 * payload with the same strictness as the USE bridge contract (one vector
 * per input, uniform engine-reported dimension, finite numbers, stable
 * order). Throws instead of fabricating vectors.
 */
export class NativeNeedleEmbedder implements NeedleEmbedder {
  readonly modelId = NEEDLE_MODEL_ID;

  constructor(
    private readonly bridge: NativeNeedleBridge,
    private readonly probedDimension: number,
  ) {
    if (!Number.isInteger(probedDimension) || probedDimension <= 0) {
      throw new Error("Invalid needle embedding dimension");
    }
  }

  get dimension(): number {
    return this.probedDimension;
  }

  async embedNeedleTexts(texts: string[]): Promise<number[][]> {
    assertValidInputs(texts);
    const available = await this.bridge.isNeedleAvailable();
    if (available !== true) {
      throw new Error("Needle engine is not available on this device");
    }
    const vectors = await this.bridge.embedNeedleTexts(texts);
    return validateNeedleVectors(texts, vectors, this.probedDimension);
  }
}
