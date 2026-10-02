/**
 * WS6 golden-corpus types + pure validation/scoring helpers for the benchmark
 * harness skeleton (tools/bench/runBench.mjs, tools/bench/score.mjs).
 *
 * Shape mirrors tools/bench/goldenCorpus.schema.json. No dependencies, no
 * I/O, no models: validation reports cross-schema errors (relevantIds must
 * match candidate ids, requiredFields must name known expected fields) that
 * JSON Schema alone cannot express.
 */

import type { Category } from "@findback/shared";

/** Corpus revision pinned into every benchmark record (e.g. "ws6-v1"). */
export const GOLDEN_CORPUS_VERSION_PATTERN = /^ws6-v[0-9]+$/;

export interface GoldenCandidate {
  id: string;
  title: string;
  description: string | null;
  category: Category;
}

export interface GoldenQuery {
  title: string;
  description: string | null;
  category: Category;
}

export interface TextMatchPair {
  id: string;
  query: GoldenQuery;
  candidates: GoldenCandidate[];
  relevantIds: string[];
  notes?: string;
}

/** Expected structured fields for a photo-analysis golden case. */
export interface ExpectedPhotoFields {
  objectName: string;
  suggestedCategory: string;
  colors: string[];
  visibleBrand?: string | null;
  visibleText?: string[];
  identifyingFeatures?: string[];
  suggestedTitle: string;
  suggestedDescription: string;
  uncertainFields?: string[];
}

export type ExpectedPhotoFieldName = keyof ExpectedPhotoFields;

/** Field names the harness is allowed to score. */
export const KNOWN_PHOTO_FIELDS: readonly ExpectedPhotoFieldName[] = [
  "objectName",
  "suggestedCategory",
  "colors",
  "visibleBrand",
  "visibleText",
  "identifyingFeatures",
  "suggestedTitle",
  "suggestedDescription",
  "uncertainFields",
];

export interface PhotoCase {
  id: string;
  /** Repo-local fixture path or stable fixture id. Never a remote URL. */
  imageRef: string;
  instruction: string;
  expected: ExpectedPhotoFields;
  requiredFields: ExpectedPhotoFieldName[];
  notes?: string;
}

export interface GoldenCorpus {
  corpusVersion: string;
  textMatchPairs: TextMatchPair[];
  photoCases: PhotoCase[];
}

/** Per-config aggregates written into a benchmark record. */
export interface BenchmarkConfigResult {
  count: number;
  recallAt1: number;
  recallAt3: number;
  mrr: number;
  ndcgAt3: number;
  meanLatencyMs?: number;
}

/** Benchmark-record JSON written by tools/bench/runBench.mjs. */
export interface BenchmarkRecord {
  benchmark: "ws6-golden-corpus";
  corpusVersion: string;
  modelRev: string;
  runtimeRev: string;
  appSha: string;
  createdAt: string;
  configs: Record<string, BenchmarkConfigResult>;
  photoCases: {
    total: number;
    executed: number;
    status: "skipped" | "executed";
    reason: string;
  };
  memoryNote: string;
}

/**
 * Validates a parsed corpus value. Returns error strings (empty = valid).
 * Checks version shape, non-empty ids, candidate minimums, relevantIds
 * cross-references, duplicate ids, and requiredFields cross-references.
 */
export function validateGoldenCorpus(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) return ["corpus root must be an object"];
  const doc = value as Partial<GoldenCorpus>;

  if (typeof doc.corpusVersion !== "string" || !GOLDEN_CORPUS_VERSION_PATTERN.test(doc.corpusVersion)) {
    errors.push('corpusVersion must match /^ws6-v[0-9]+$/ (e.g. "ws6-v1")');
  }
  if (!Array.isArray(doc.textMatchPairs)) errors.push("textMatchPairs must be an array");
  if (!Array.isArray(doc.photoCases)) errors.push("photoCases must be an array");

  const seenIds = new Set<string>();
  const claimId = (id: unknown, where: string): void => {
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${where} must have a non-empty string id`);
      return;
    }
    if (seenIds.has(id)) errors.push(`duplicate record id: ${id}`);
    seenIds.add(id);
  };

  for (const pair of doc.textMatchPairs ?? []) {
    claimId(pair?.id, "textMatchPair");
    if (!pair || typeof pair !== "object") {
      errors.push("textMatchPair must be an object");
      continue;
    }
    const candidateIds = new Set((pair.candidates ?? []).map((c) => c?.id));
    if ((pair.candidates ?? []).length < 2) {
      errors.push(`pair ${pair.id}: needs at least 2 candidates for a ranking`);
    }
    if ((pair.relevantIds ?? []).length === 0) {
      errors.push(`pair ${pair.id}: relevantIds must be non-empty`);
    }
    for (const rel of pair.relevantIds ?? []) {
      if (!candidateIds.has(rel)) errors.push(`pair ${pair.id}: relevantId ${rel} matches no candidate`);
    }
  }

  const knownFields = new Set<string>(KNOWN_PHOTO_FIELDS);
  for (const photo of doc.photoCases ?? []) {
    claimId(photo?.id, "photoCase");
    if (!photo || typeof photo !== "object") {
      errors.push("photoCase must be an object");
      continue;
    }
    if (typeof photo.imageRef !== "string" || photo.imageRef.length === 0) {
      errors.push(`photoCase ${photo.id}: imageRef must be a non-empty fixture ref`);
    }
    if ((photo.requiredFields ?? []).length === 0) {
      errors.push(`photoCase ${photo.id}: requiredFields must be non-empty`);
    }
    for (const field of photo.requiredFields ?? []) {
      if (!knownFields.has(field)) errors.push(`photoCase ${photo.id}: unknown required field ${field}`);
    }
  }
  return errors;
}

function normalizedEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function stringSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  const normA = a.map((s) => s.trim().toLowerCase()).sort();
  const normB = b.map((s) => s.trim().toLowerCase()).sort();
  return normA.length === normB.length && normA.every((s, i) => s === normB[i]);
}

function fieldEquals(field: ExpectedPhotoFieldName, expected: ExpectedPhotoFields, actual: unknown): boolean {
  const want = expected[field];
  if (want === undefined) return actual === undefined;
  if (typeof want === "string") return typeof actual === "string" && normalizedEqual(want, actual);
  if (want === null) return actual === null;
  if (Array.isArray(want)) {
    if (!Array.isArray(actual)) return false;
    const items = actual as unknown[];
    if (want.length > 0 && typeof want[0] === "string") {
      if (!items.every((i) => typeof i === "string")) return false;
      return stringSetsEqual(want as string[], items as string[]);
    }
    return JSON.stringify([...(want as unknown[])].sort()) === JSON.stringify([...items].sort());
  }
  return false;
}

/**
 * Scores one photo case: per-required-field 1/0 (normalized string compare,
 * order-insensitive string-set compare, null-aware) plus the mean. Pure.
 */
export function scorePhotoCase(
  expected: ExpectedPhotoFields,
  actual: Record<string, unknown>,
  requiredFields: readonly ExpectedPhotoFieldName[],
): { fieldScores: Record<string, number>; mean: number } {
  const fieldScores: Record<string, number> = {};
  for (const field of requiredFields) {
    fieldScores[field] = fieldEquals(field, expected, actual[field]) ? 1 : 0;
  }
  const values = Object.values(fieldScores);
  const mean = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  return { fieldScores, mean };
}
