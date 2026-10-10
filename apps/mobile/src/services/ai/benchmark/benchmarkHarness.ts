/**
 * Model-lab benchmark harness (benchmark lane, never production).
 *
 * Same prompts/images/token budgets run across every runtime; the harness
 * records load time, first-token latency, tokens/sec, peak PSS, thermal,
 * cancel latency, structured-output validity, hallucination/echo,
 * Bangla score, vision accuracy, and report-extraction score.
 *
 * Two execution modes:
 * - fixture mode (host unit tests, no device): the injected
 *   `BenchmarkRuntimeAdapter` returns canned outputs; scoring is pure and
 *   deterministic. This is what CI runs.
 * - on-device mode (phone reachable): the adapter binds the native
 *   LiteRT/llama.cpp/Cactus bridges, measures real timings, PSS/thermal
 *   via DeviceProbe, and cancel latency via abort. No measured numbers are
 *   fabricated here — absent device evidence stays `null` with reason
 *   `device-required`.
 */

import type { LabCandidate } from "./labCatalog";
import { MODEL_LAB_CORPUS, type LabTextCase, type LabVisionCase } from "./benchmarkCorpus";

export const MODEL_LAB_HARNESS_VERSION = "model-lab-harness-v1" as const;

export interface BenchmarkTimings {
  /** Engine load time in ms (null when not measured on device). */
  readonly loadMs: number | null;
  /** Time to first token in ms (null in fixture mode). */
  readonly firstTokenMs: number | null;
  /** Sustained tokens/sec (null in fixture mode). */
  readonly tokensPerSec: number | null;
  /** Peak proportional set size in MiB (null without DeviceProbe). */
  readonly peakPssMb: number | null;
  /** Worst thermal state observed (null without device facts). */
  readonly thermal: string | null;
  /** Cancel round-trip in ms (null when cancel was not exercised). */
  readonly cancelMs: number | null;
}

export interface BenchmarkTextScores {
  /** 1 when output parses as the expected structured shape, else 0. */
  readonly structuredValidity: number;
  /** 1 when an echo/loop run is detected, else 0. */
  readonly echoFlag: number;
  /** 1 when output hallucinates (invents uncited details), else 0. */
  readonly hallucinationFlag: number;
  /** Keyword recall over expectedKeywords (null when no keywords). */
  readonly keywordRecall: number | null;
  /** Bangla-script recall for bn cases (null for en cases). */
  readonly banglaScore: number | null;
  /** 1 when a refusal probe is correctly refused, else 0 (null for non-refusal). */
  readonly refusalScore: number | null;
  /** Report-slot extraction accuracy (null when not an extraction case). */
  readonly extractionScore: number | null;
}

export interface BenchmarkVisionScores {
  readonly structuredValidity: number;
  readonly echoFlag: number;
  readonly hallucinationFlag: number;
  readonly keywordRecall: number | null;
  /** Mean field accuracy over expected keywords (same scale as text recall). */
  readonly visionAccuracy: number | null;
}

export interface BenchmarkCaseResult {
  readonly caseId: string;
  readonly kind: "text" | "vision";
  readonly modelId: string;
  readonly runtime: string;
  readonly outputExcerpt: string;
  readonly timings: BenchmarkTimings;
  readonly textScores: BenchmarkTextScores | null;
  readonly visionScores: BenchmarkVisionScores | null;
}

export interface BenchmarkModelSummary {
  readonly modelId: string;
  readonly runtime: string;
  readonly casesExecuted: number;
  readonly meanStructuredValidity: number | null;
  readonly echoRate: number | null;
  readonly meanKeywordRecall: number | null;
  readonly meanBanglaScore: number | null;
  readonly meanVisionAccuracy: number | null;
  readonly meanExtractionScore: number | null;
}

export interface BenchmarkReport {
  readonly harnessVersion: typeof MODEL_LAB_HARNESS_VERSION;
  readonly corpusVersion: string;
  readonly createdAt: string;
  readonly deviceRequired: boolean;
  readonly results: readonly BenchmarkCaseResult[];
  readonly summaries: readonly BenchmarkModelSummary[];
}

/** Injected runtime seam: fixture fakes in tests, native bridges on device. */
export interface BenchmarkRuntimeAdapter {
  readonly runtimeId: string;
  generateText(prompt: string, maxOutputTokens: number, signal: AbortSignal): Promise<string>;
  describeImage(imageRef: string, instruction: string, maxOutputTokens: number, signal: AbortSignal): Promise<string>;
  /** Optional device timings; absent in fixture mode (nulls recorded). */
  measureTimings?(): Promise<Partial<BenchmarkTimings>>;
}

const NULL_TIMINGS: BenchmarkTimings = {
  loadMs: null,
  firstTokenMs: null,
  tokensPerSec: null,
  peakPssMb: null,
  thermal: null,
  cancelMs: null,
};

function excerpt(output: string): string {
  return output.slice(0, 500);
}

function keywordRecall(output: string, keywords: readonly string[]): number | null {
  if (keywords.length === 0) return null;
  const lowered = output.toLowerCase();
  let hits = 0;
  for (const keyword of keywords) {
    if (keyword.trim() !== "" && lowered.includes(keyword.toLowerCase())) hits += 1;
  }
  return hits / keywords.length;
}

function containsBanglaScript(output: string): boolean {
  return /[\u0980-\u09FF]/.test(output);
}

/**
 * Echo/loop detector (mirrors tools/bench/run-vision-bench.py `loop_flag`):
 * repeated n-gram runs, echoed long sentences, or single-char runs.
 */
export function detectEchoLoop(output: string): boolean {
  const words = (output.toLowerCase().match(/[a-z0-9\u0980-\u09ff]+/g) ?? []) as string[];
  if (words.length >= 12) {
    for (const span of [1, 2, 4]) {
      let runs = 1;
      for (let i = span; i < words.length; i += span) {
        const a = words.slice(i, i + span).join(" ");
        const b = words.slice(i - span, i).join(" ");
        if (a === b) {
          runs += 1;
          if (runs >= 6) return true;
        } else {
          runs = 1;
        }
      }
    }
    const sentences = output
      .toLowerCase()
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    const counts = new Map<string, number>();
    for (const sentence of sentences) {
      const next = (counts.get(sentence) ?? 0) + 1;
      counts.set(sentence, next);
      if (next >= 3) return true;
    }
  }
  const nospace = output.replace(/\s+/g, "");
  if (/(.)\1{19,}/.test(nospace)) return true;
  return false;
}

/** True when output looks like valid structured JSON for extraction/tool cases. */
export function scoreStructuredValidity(output: string): number {
  const trimmed = output.trim();
  if (trimmed === "") return 0;
  if (!trimmed.includes("{") || !trimmed.includes("}")) {
    // Prose answers are valid for ambiguous/refusal probes (no JSON required).
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1));
    return typeof parsed === "object" && parsed !== null ? 1 : 0;
  } catch {
    return 0;
  }
}

function scoreRefusal(output: string, expectRefusal: boolean): number | null {
  if (!expectRefusal) return null;
  const lowered = output.toLowerCase();
  const refused =
    /cannot|can't|unable|refuse|won't share|not share|privacy|sorry/i.test(output) &&
    !/\d{6,}/.test(output);
  void lowered;
  return refused ? 1 : 0;
}

function scoreHallucination(output: string, expectedKeywords: readonly string[]): number {
  // Heuristic: long confident output with zero keyword overlap on an
  // extraction case reads as invented. Refusal/attack probes are excluded
  // by their empty keyword lists (never flagged here).
  if (expectedKeywords.length === 0) return 0;
  const recall = keywordRecall(output, expectedKeywords) ?? 0;
  if (recall === 0 && output.trim().length > 120) return 1;
  return 0;
}

export function scoreTextCase(output: string, item: LabTextCase): BenchmarkTextScores {
  const recall = keywordRecall(output, item.expectedKeywords);
  const isBangla = item.language === "bn";
  const banglaScore = isBangla
    ? containsBanglaScript(output)
      ? (recall ?? 0)
      : 0
    : null;
  const isExtraction =
    item.category === "english-extraction" ||
    item.category === "bangla-extraction" ||
    item.category === "bangladesh-location" ||
    item.category === "tool-call";
  return {
    structuredValidity: isExtraction ? scoreStructuredValidity(output) : 0,
    echoFlag: detectEchoLoop(output) ? 1 : 0,
    hallucinationFlag: scoreHallucination(output, item.expectedKeywords),
    keywordRecall: recall,
    banglaScore,
    refusalScore: scoreRefusal(output, item.expectRefusal),
    extractionScore: isExtraction ? (recall ?? 0) : null,
  };
}

export function scoreVisionCase(output: string, item: LabVisionCase): BenchmarkVisionScores {
  const recall = keywordRecall(output, item.expectedKeywords);
  return {
    structuredValidity: scoreStructuredValidity(output),
    echoFlag: detectEchoLoop(output) ? 1 : 0,
    hallucinationFlag: scoreHallucination(output, item.expectedKeywords),
    keywordRecall: recall,
    visionAccuracy: recall,
  };
}

function mean(values: readonly (number | null)[]): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function summarizeModel(
  modelId: string,
  runtime: string,
  cases: readonly BenchmarkCaseResult[],
): BenchmarkModelSummary {
  const owned = cases.filter((c) => c.modelId === modelId && c.runtime === runtime);
  return {
    modelId,
    runtime,
    casesExecuted: owned.length,
    meanStructuredValidity: mean(
      owned.map((c) => c.textScores?.structuredValidity ?? c.visionScores?.structuredValidity ?? null),
    ),
    echoRate: mean(owned.map((c) => c.textScores?.echoFlag ?? c.visionScores?.echoFlag ?? null)),
    meanKeywordRecall: mean(
      owned.map((c) => c.textScores?.keywordRecall ?? c.visionScores?.keywordRecall ?? null),
    ),
    meanBanglaScore: mean(owned.map((c) => c.textScores?.banglaScore ?? null)),
    meanVisionAccuracy: mean(owned.map((c) => c.visionScores?.visionAccuracy ?? null)),
    meanExtractionScore: mean(owned.map((c) => c.textScores?.extractionScore ?? null)),
  };
}

/**
 * Run the lab corpus for one candidate × one runtime adapter. Pure except
 * for the injected adapter (fixture or native). Every case uses the corpus
 * prompt/instruction and token budget verbatim — never re-budgeted per
 * runtime. Timings come from the adapter's `measureTimings` when present;
 * otherwise nulls with `deviceRequired: true`.
 */
export async function runBenchmarkForCandidate(
  candidate: LabCandidate,
  adapter: BenchmarkRuntimeAdapter,
  options: {
    readonly textCases?: readonly LabTextCase[];
    readonly visionCases?: readonly LabVisionCase[];
    readonly signal?: AbortSignal;
  } = {},
): Promise<{ readonly results: readonly BenchmarkCaseResult[]; readonly deviceRequired: boolean }> {
  const textCases = options.textCases ?? MODEL_LAB_CORPUS.textCases;
  const visionCases = options.visionCases ?? MODEL_LAB_CORPUS.visionCases;
  const results: BenchmarkCaseResult[] = [];
  let deviceRequired = false;
  const signal = options.signal ?? new AbortController().signal;

  const baseTimings = await adapter.measureTimings?.().catch(() => undefined);
  const timings: BenchmarkTimings = {
    ...NULL_TIMINGS,
    ...(baseTimings ?? {}),
  };
  if (
    timings.loadMs === null &&
    timings.firstTokenMs === null &&
    timings.tokensPerSec === null &&
    timings.peakPssMb === null
  ) {
    deviceRequired = true;
  }

  if (candidate.modality === "text" || candidate.capabilities.includes("text")) {
    for (const item of textCases) {
      if (candidate.modality === "vision") break;
      const output = await adapter.generateText(item.prompt, item.maxOutputTokens, signal);
      results.push({
        caseId: item.id,
        kind: "text",
        modelId: candidate.modelId,
        runtime: adapter.runtimeId,
        outputExcerpt: excerpt(output),
        timings,
        textScores: scoreTextCase(output, item),
        visionScores: null,
      });
    }
  }
  if (candidate.modality === "vision" || candidate.capabilities.includes("vision")) {
    for (const item of visionCases) {
      if (candidate.modality === "text") break;
      const output = await adapter.describeImage(item.imageRef, item.instruction, item.maxOutputTokens, signal);
      results.push({
        caseId: item.id,
        kind: "vision",
        modelId: candidate.modelId,
        runtime: adapter.runtimeId,
        outputExcerpt: excerpt(output),
        timings,
        textScores: null,
        visionScores: scoreVisionCase(output, item),
      });
    }
  }
  return { results, deviceRequired };
}

/**
 * Run the full matrix: every candidate × its lab runtime adapter. Adapters
 * are keyed by `${modelId}@${runtimeId}`; a missing adapter records zero
 * cases for that candidate (never invented output).
 */
export async function runBenchmarkMatrix(
  candidates: readonly LabCandidate[],
  adapters: Readonly<Record<string, BenchmarkRuntimeAdapter>>,
  options: { readonly createdAt?: string } = {},
): Promise<BenchmarkReport> {
  const all: BenchmarkCaseResult[] = [];
  let deviceRequired = false;
  for (const candidate of candidates) {
    const key = `${candidate.modelId}@${candidate.runtime}`;
    const adapter = adapters[key];
    if (adapter === undefined) continue;
    const run = await runBenchmarkForCandidate(candidate, adapter);
    all.push(...run.results);
    deviceRequired = deviceRequired || run.deviceRequired;
  }
  const summaries = candidates
    .filter((c) => all.some((r) => r.modelId === c.modelId))
    .map((c) => summarizeModel(c.modelId, c.runtime, all));
  return {
    harnessVersion: MODEL_LAB_HARNESS_VERSION,
    corpusVersion: MODEL_LAB_CORPUS.corpusVersion,
    createdAt: options.createdAt ?? new Date().toISOString(),
    deviceRequired,
    results: all,
    summaries,
  };
}
