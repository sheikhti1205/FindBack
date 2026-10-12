/**
 * Model-lab benchmark score calculator (lab lane, never production).
 *
 * Static infrastructure only: deterministic pure scoring — keyword recall,
 * structured-output validity, echo/loop flag, and lane means. No dates, no
 * randomness, no I/O: identical inputs always produce identical outputs.
 * Fixture outputs in tests prove determinism without a device.
 */

export interface BenchmarkOutputScores {
  /** Keyword recall over expected keywords (null when no keywords). */
  readonly keywordRecall: number | null;
  /** 1 when output parses as structured JSON, else 0. */
  readonly structuredValidity: number;
  /** 1 when an echo/loop run is detected, else 0. */
  readonly echoFlag: number;
  /** Mean of keywordRecall (as 0/1-normalized) and structuredValidity. */
  readonly mean: number;
}

/** Case-insensitive keyword recall. Null when there is nothing to match. */
export function benchmarkKeywordRecall(
  output: string,
  expectedKeywords: readonly string[],
): number | null {
  const keywords = expectedKeywords.filter((keyword) => keyword.trim() !== "");
  if (keywords.length === 0) return null;
  const lowered = output.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (lowered.includes(keyword.toLowerCase())) hits += 1;
  }
  return hits / keywords.length;
}

/** 1 when the output holds exactly one parseable JSON object, else 0. */
export function benchmarkStructuredValidity(output: string): number {
  const trimmed = output.trim();
  if (trimmed === "") return 0;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return 0;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * Echo/loop detector: repeated word n-gram runs, echoed long sentences, or
 * single-character runs. Deterministic string scan.
 */
export function benchmarkEchoFlag(output: string): number {
  const words = output.toLowerCase().match(/[a-z0-9\u0980-\u09ff]+/g) ?? [];
  if (words.length >= 12) {
    for (const span of [1, 2, 4]) {
      let runs = 1;
      for (let i = span; i + span <= words.length; i += span) {
        const a = words.slice(i, i + span).join(" ");
        const b = words.slice(i - span, i).join(" ");
        if (a !== "" && a === b) {
          runs += 1;
          if (runs >= 6) return 1;
        } else {
          runs = 1;
        }
      }
    }
    const sentences = output
      .toLowerCase()
      .split(/[.!?]+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 20);
    const counts = new Map<string, number>();
    for (const sentence of sentences) {
      const next = (counts.get(sentence) ?? 0) + 1;
      counts.set(sentence, next);
      if (next >= 3) return 1;
    }
  }
  if (/(.)\1{19,}/.test(output.replace(/\s+/g, ""))) return 1;
  return 0;
}

/** Scores one output against its expected keywords. Pure. */
export function scoreBenchmarkOutput(
  output: string,
  expectedKeywords: readonly string[],
): BenchmarkOutputScores {
  const keywordRecall = benchmarkKeywordRecall(output, expectedKeywords);
  const structuredValidity = benchmarkStructuredValidity(output);
  const echoFlag = benchmarkEchoFlag(output);
  const recallComponent = keywordRecall ?? 0;
  return {
    keywordRecall,
    structuredValidity,
    echoFlag,
    mean: (recallComponent + structuredValidity) / 2,
  };
}

/**
 * Mean of finite numbers, ignoring nulls. Null when no finite input —
 * never NaN. Pure.
 */
export function benchmarkMean(values: readonly (number | null)[]): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/** Aggregates per-output scores into lane means. Pure. */
export function aggregateBenchmarkScores(scores: readonly BenchmarkOutputScores[]): {
  readonly count: number;
  readonly meanKeywordRecall: number | null;
  readonly meanStructuredValidity: number | null;
  readonly echoRate: number | null;
  readonly mean: number | null;
} {
  return {
    count: scores.length,
    meanKeywordRecall: benchmarkMean(scores.map((score) => score.keywordRecall)),
    meanStructuredValidity: benchmarkMean(scores.map((score) => score.structuredValidity)),
    echoRate: benchmarkMean(scores.map((score) => score.echoFlag)),
    mean: benchmarkMean(scores.map((score) => score.mean)),
  };
}
