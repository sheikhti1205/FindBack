/**
 * Model-lab benchmark report generator (lab lane, never production).
 *
 * Static infrastructure only: builds the comparison format — one row per
 * candidate with lane means and an honest status. With no device runs every
 * row is UNMEASURED; fixture-only logs read FIXTURE-ONLY; only phone
 * evidence reads DEVICE-MEASURED. Nothing here selects, ranks for shipment,
 * or wires into production surfaces. Pure; createdAt is caller-pinned in
 * tests for determinism.
 */

import type { BenchmarkCandidateMeta } from "./benchmarkCandidateSchema";
import { benchmarkMean } from "./benchmarkScoreCalculator";
import type { BenchmarkStructuredRecord } from "./benchmarkResultLogger";

export type BenchmarkRowStatus = "UNMEASURED" | "FIXTURE-ONLY" | "DEVICE-MEASURED";

export interface BenchmarkComparisonRow {
  readonly candidateId: string;
  readonly displayName: string;
  readonly modality: string;
  readonly casesExecuted: number;
  readonly meanKeywordRecall: number | null;
  readonly meanStructuredValidity: number | null;
  readonly status: BenchmarkRowStatus;
}

export interface BenchmarkComparisonReport {
  readonly format: "findback-lab-comparison-v1";
  readonly corpusVersion: string;
  readonly createdAt: string;
  readonly rows: readonly BenchmarkComparisonRow[];
}

function rowStatus(
  owned: readonly BenchmarkStructuredRecord[],
): BenchmarkRowStatus {
  if (owned.length === 0) return "UNMEASURED";
  return owned.every((record) => record.deviceRequired) ? "FIXTURE-ONLY" : "DEVICE-MEASURED";
}

/** Builds the comparison report for candidates in catalogue order. Pure. */
export function buildBenchmarkComparison(
  candidates: readonly BenchmarkCandidateMeta[],
  records: readonly BenchmarkStructuredRecord[],
  input: { readonly corpusVersion: string; readonly createdAt?: string },
): BenchmarkComparisonReport {
  const rows = candidates.map((candidate) => {
    const owned = records.filter((record) => record.candidateId === candidate.modelId);
    return {
      candidateId: candidate.modelId,
      displayName: candidate.displayName,
      modality: candidate.modality,
      casesExecuted: owned.length,
      meanKeywordRecall: benchmarkMean(owned.map((record) => record.scores["keywordRecall"] ?? null)),
      meanStructuredValidity: benchmarkMean(
        owned.map((record) => record.scores["structuredValidity"] ?? null),
      ),
      status: rowStatus(owned),
    } satisfies BenchmarkComparisonRow;
  });
  return {
    format: "findback-lab-comparison-v1",
    corpusVersion: input.corpusVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
    rows,
  };
}

/** Renders the comparison report as Markdown. Pure. */
export function renderBenchmarkComparisonMarkdown(report: BenchmarkComparisonReport): string {
  const lines = [
    "# Model-lab benchmark comparison",
    "",
    `Corpus: ${report.corpusVersion} | Created: ${report.createdAt}`,
    "",
    "| Candidate | Modality | Cases | Keyword recall | Structured validity | Status |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    const recall = row.meanKeywordRecall === null ? "—" : row.meanKeywordRecall.toFixed(3);
    const validity = row.meanStructuredValidity === null ? "—" : row.meanStructuredValidity.toFixed(3);
    lines.push(
      `| ${row.displayName} | ${row.modality} | ${row.casesExecuted} | ${recall} | ${validity} | ${row.status} |`,
    );
  }
  return lines.join("\n");
}
