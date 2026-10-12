/**
 * Model-lab benchmark structured-result logger (lab lane, never production).
 *
 * Static infrastructure only: builds, appends, serializes, and re-validates
 * structured result records. Pure — records are values, the log is an
 * immutable array, serialization is JSON lines. No filesystem, no network,
 * no device access. Absent device evidence stays null with an explicit
 * device-required reason.
 */

export const BENCHMARK_RECORD_SCHEMA = "findback-lab-bench-v1" as const;

export interface BenchmarkStructuredRecord {
  readonly schema: typeof BENCHMARK_RECORD_SCHEMA;
  readonly corpusVersion: string;
  readonly candidateId: string;
  readonly caseId: string;
  readonly kind: "text" | "vision";
  readonly outputExcerpt: string;
  readonly scores: Readonly<Record<string, number | null>>;
  readonly ramPssMb: number | null;
  readonly thermal: string | null;
  readonly deviceRequired: boolean;
  readonly createdAt: string;
}

export interface BenchmarkRecordInit {
  readonly corpusVersion: string;
  readonly candidateId: string;
  readonly caseId: string;
  readonly kind: "text" | "vision";
  readonly outputExcerpt: string;
  readonly scores: Readonly<Record<string, number | null>>;
  readonly ramPssMb: number | null;
  readonly thermal: string | null;
  readonly deviceRequired: boolean;
  readonly createdAt?: string;
}

/** Builds one record; createdAt defaults to now (callers may pin it). */
export function buildBenchmarkRecord(init: BenchmarkRecordInit): BenchmarkStructuredRecord {
  return {
    schema: BENCHMARK_RECORD_SCHEMA,
    corpusVersion: init.corpusVersion,
    candidateId: init.candidateId,
    caseId: init.caseId,
    kind: init.kind,
    outputExcerpt: init.outputExcerpt,
    scores: { ...init.scores },
    ramPssMb: init.ramPssMb,
    thermal: init.thermal,
    deviceRequired: init.deviceRequired,
    createdAt: init.createdAt ?? new Date().toISOString(),
  };
}

/** Returns a new log with the record appended (input untouched). */
export function appendBenchmarkRecord(
  log: readonly BenchmarkStructuredRecord[],
  record: BenchmarkStructuredRecord,
): readonly BenchmarkStructuredRecord[] {
  return [...log, record];
}

/** Serializes a log as JSON lines (one record per line). Pure. */
export function serializeBenchmarkLog(log: readonly BenchmarkStructuredRecord[]): string {
  return log.map((record) => JSON.stringify(record)).join("\n");
}

/**
 * Re-validates parsed log lines. Returns the valid records plus error
 * strings for malformed lines. Pure.
 */
export function parseBenchmarkLog(text: string): {
  readonly records: readonly BenchmarkStructuredRecord[];
  readonly errors: readonly string[];
} {
  const records: BenchmarkStructuredRecord[] = [];
  const errors: string[] = [];
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      errors.push(`line ${index + 1}: invalid JSON`);
      return;
    }
    const recordErrors = validateBenchmarkRecord(parsed);
    if (recordErrors.length > 0) {
      for (const message of recordErrors) errors.push(`line ${index + 1}: ${message}`);
      return;
    }
    records.push(parsed as BenchmarkStructuredRecord);
  });
  return { records, errors };
}

/** Validates one parsed record value. Returns error strings (empty = valid). */
export function validateBenchmarkRecord(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) return ["record must be an object"];
  const record = value as Partial<BenchmarkStructuredRecord>;
  if (record.schema !== BENCHMARK_RECORD_SCHEMA) {
    errors.push(`schema must be "${BENCHMARK_RECORD_SCHEMA}"`);
  }
  for (const field of ["corpusVersion", "candidateId", "caseId", "createdAt"] as const) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (record.kind !== "text" && record.kind !== "vision") {
    errors.push('kind must be "text" or "vision"');
  }
  if (typeof record.outputExcerpt !== "string") errors.push("outputExcerpt must be a string");
  if (typeof record.scores !== "object" || record.scores === null) {
    errors.push("scores must be an object");
  } else {
    for (const [key, score] of Object.entries(record.scores)) {
      if (score !== null && (typeof score !== "number" || !Number.isFinite(score))) {
        errors.push(`scores.${key} must be a finite number or null`);
      }
    }
  }
  if (record.ramPssMb !== null && (typeof record.ramPssMb !== "number" || !Number.isFinite(record.ramPssMb))) {
    errors.push("ramPssMb must be a finite number or null");
  }
  if (record.thermal !== null && typeof record.thermal !== "string") {
    errors.push("thermal must be a string or null");
  }
  if (typeof record.deviceRequired !== "boolean") errors.push("deviceRequired must be a boolean");
  return errors;
}
