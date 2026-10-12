/**
 * Model-lab benchmark candidate metadata schema (lab lane, never production).
 *
 * Static infrastructure only: the exact fields every candidate must carry
 * before any device run — upstream revision, artifact hash, byte size,
 * license, and redistribution rule, plus runtime/format, task roles, prompt
 * template, token budget, and thinking mode. Every entry in
 * `BENCHMARK_CANDIDATES` is an UNMEASURED data record: no measured RAM or
 * speed claims, no production pick flag, no chooser wiring, no artifact
 * fetch. Enforcement lives in `benchmarkDownloadGate.ts`; this module only
 * describes and validates.
 *
 * DEVICE UNAVAILABLE: byte sizes stay null until confirmed against upstream
 * bytes on a reachable phone; null bytes keep weight channels blocked.
 */

export type BenchmarkLabModality = "text" | "vision";

export type BenchmarkLabRuntime = "litert-lm" | "llama-cpp" | "needle-cact" | "cactus-lab";

export type BenchmarkLabFormat = "litertlm" | "gguf" | "cact";

export type BenchmarkLabChannel = "bundle" | "download" | "benchmark" | "eval";

export type BenchmarkRedistribution =
  | "redistributable"
  | "benchmark-eval-only"
  | "pending-verification";

/** Sentinel for revision/hash/license fields awaiting upstream confirmation. */
export const PENDING_VERIFICATION = "pending-verification" as const;

export interface BenchmarkCandidateMeta {
  readonly modelId: string;
  readonly displayName: string;
  readonly modality: BenchmarkLabModality;
  /** Upstream repo (org/name) the artifact is sourced from. */
  readonly upstreamRepo: string;
  readonly fileName: string;
  /** Exact upstream revision (commit/tag), or "pending-verification". */
  readonly revision: string;
  /** SHA-256 of the exact downloadable bytes, or "pending-verification". */
  readonly sha256: string;
  /** Exact artifact byte size, or null until confirmed against upstream. */
  readonly artifactBytes: number | null;
  /** Human-readable license id, or "pending-verification". */
  readonly license: string;
  readonly redistribution: BenchmarkRedistribution;
  readonly runtime: BenchmarkLabRuntime;
  readonly format: BenchmarkLabFormat;
  readonly taskRoles: readonly string[];
  readonly promptTemplate: string;
  readonly tokenBudget: number;
  readonly thinkingMode: "disabled";
  /**
   * Static-infra invariant: always false. A measured run never mutates this
   * list; measurements land in result logs owned by the device run.
   */
  readonly measured: false;
  /** True only when revision+sha were confirmed against upstream. */
  readonly pinsVerified: boolean;
  /** Consumer-safe one-line note (no ids/hashes). */
  readonly labNote: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function pinOrPending(value: string, hex: RegExp): boolean {
  return value === PENDING_VERIFICATION || hex.test(value);
}

/**
 * Validates one candidate record. Returns error strings (empty = valid).
 * Pure; no I/O, no network, no production-lane access.
 */
export function validateBenchmarkCandidate(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) return ["candidate must be an object"];
  const c = value as Partial<BenchmarkCandidateMeta>;

  if (typeof c.modelId !== "string" || c.modelId.length === 0) {
    errors.push("modelId must be a non-empty string");
  }
  if (typeof c.displayName !== "string" || c.displayName.length === 0) {
    errors.push(`${String(c.modelId)}: displayName must be a non-empty string`);
  }
  if (c.modality !== "text" && c.modality !== "vision") {
    errors.push(`${String(c.modelId)}: modality must be "text" or "vision"`);
  }
  if (typeof c.upstreamRepo !== "string" || c.upstreamRepo.length === 0) {
    errors.push(`${String(c.modelId)}: upstreamRepo must be a non-empty string`);
  }
  if (typeof c.fileName !== "string" || c.fileName.length === 0) {
    errors.push(`${String(c.modelId)}: fileName must be a non-empty string`);
  }
  if (typeof c.revision !== "string" || !pinOrPending(c.revision, HEX40)) {
    errors.push(`${String(c.modelId)}: revision must be a 40-hex pin or "pending-verification"`);
  }
  if (typeof c.sha256 !== "string" || !pinOrPending(c.sha256, HEX64)) {
    errors.push(`${String(c.modelId)}: sha256 must be a 64-hex pin or "pending-verification"`);
  }
  if (c.artifactBytes !== null && !(typeof c.artifactBytes === "number" && Number.isInteger(c.artifactBytes) && c.artifactBytes > 0)) {
    errors.push(`${String(c.modelId)}: artifactBytes must be a positive integer or null`);
  }
  if (typeof c.license !== "string" || c.license.length === 0) {
    errors.push(`${String(c.modelId)}: license must be a non-empty string`);
  }
  if (
    c.redistribution !== "redistributable" &&
    c.redistribution !== "benchmark-eval-only" &&
    c.redistribution !== "pending-verification"
  ) {
    errors.push(`${String(c.modelId)}: redistribution must be a known rule`);
  }
  if (c.license === "LFM-1.0" && c.redistribution !== "benchmark-eval-only") {
    errors.push(`${String(c.modelId)}: LFM-1.0 must be benchmark-eval-only`);
  }
  if (c.redistribution === "redistributable" && c.pinsVerified !== true) {
    errors.push(`${String(c.modelId)}: redistributable requires verified pins`);
  }
  if (c.redistribution === "pending-verification" && c.pinsVerified === true) {
    errors.push(`${String(c.modelId)}: pending-verification redistribution cannot carry verified pins`);
  }
  if (c.pinsVerified === true && (c.revision === PENDING_VERIFICATION || c.sha256 === PENDING_VERIFICATION)) {
    errors.push(`${String(c.modelId)}: verified pins require exact revision+sha`);
  }
  if (!Array.isArray(c.taskRoles) || c.taskRoles.length === 0) {
    errors.push(`${String(c.modelId)}: taskRoles must be a non-empty array`);
  }
  if (typeof c.promptTemplate !== "string" || c.promptTemplate.length === 0) {
    errors.push(`${String(c.modelId)}: promptTemplate must be a non-empty string`);
  }
  if (typeof c.tokenBudget !== "number" || !Number.isInteger(c.tokenBudget) || c.tokenBudget <= 0) {
    errors.push(`${String(c.modelId)}: tokenBudget must be a positive integer`);
  }
  if (c.thinkingMode !== "disabled") {
    errors.push(`${String(c.modelId)}: thinkingMode must be "disabled"`);
  }
  if (c.measured !== false) {
    errors.push(`${String(c.modelId)}: measured must be false (static infra is unmeasured)`);
  }
  if (typeof c.labNote !== "string" || c.labNote.length === 0) {
    errors.push(`${String(c.modelId)}: labNote must be a non-empty string`);
  }
  return errors;
}

/**
 * Validates a candidate list: per-record checks plus duplicate modelIds.
 * Pure.
 */
export function validateBenchmarkCandidates(
  list: readonly BenchmarkCandidateMeta[],
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const candidate of list) {
    errors.push(...validateBenchmarkCandidate(candidate));
    if (seen.has(candidate.modelId)) errors.push(`duplicate modelId: ${candidate.modelId}`);
    seen.add(candidate.modelId);
  }
  return errors;
}

/**
 * Static UNMEASURED candidate entries (metadata only). No entry here is a
 * measured result, a production pick, or a fetch instruction.
 */
export const BENCHMARK_CANDIDATES: readonly BenchmarkCandidateMeta[] = [
  {
    modelId: "qwen3-0.6b-dynamic-int4",
    displayName: "Qwen3 0.6B (text, unmeasured)",
    modality: "text",
    upstreamRepo: "litert-community/Qwen3-0.6B",
    fileName: "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
    revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
    sha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
    artifactBytes: null,
    license: "Apache-2.0",
    redistribution: "redistributable",
    runtime: "litert-lm",
    format: "litertlm",
    taskRoles: ["answer-help", "extract-report-fields", "extract-search-filters", "classify-intent"],
    promptTemplate: "findback-help-v1",
    tokenBudget: 256,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: true,
    labNote: "Text entry, unmeasured; byte size confirmed at device-run time.",
  },
  {
    modelId: "qwen3-1.7b-dynamic-int4",
    displayName: "Qwen3 1.7B (text, unmeasured)",
    modality: "text",
    upstreamRepo: "litert-community/Qwen3-1.7B",
    fileName: "Qwen3-1.7B_dynamic_wi4b32_afp32.litertlm",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: "Apache-2.0",
    redistribution: "pending-verification",
    runtime: "litert-lm",
    format: "litertlm",
    taskRoles: ["answer-help", "extract-report-fields", "extract-search-filters", "classify-intent"],
    promptTemplate: "findback-help-v1",
    tokenBudget: 256,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Text entry, unmeasured; no bundle/fetch until pins are verified.",
  },
  {
    modelId: "lfm2-350m-q4_0",
    displayName: "LFM2 350M (text, unmeasured)",
    modality: "text",
    upstreamRepo: "LiquidAI/LFM2-350M",
    fileName: "LFM2-350M-Q4_0.gguf",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: "LFM-1.0",
    redistribution: "benchmark-eval-only",
    runtime: "llama-cpp",
    format: "gguf",
    taskRoles: ["answer-help"],
    promptTemplate: "findback-help-v1",
    tokenBudget: 256,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Text entry, unmeasured; eval-only license, no bundling or fetch.",
  },
  {
    modelId: "lfm2-700m-q4_0",
    displayName: "LFM2 700M (text, unmeasured)",
    modality: "text",
    upstreamRepo: "LiquidAI/LFM2-700M",
    fileName: "LFM2-700M-Q4_0.gguf",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: "LFM-1.0",
    redistribution: "benchmark-eval-only",
    runtime: "llama-cpp",
    format: "gguf",
    taskRoles: ["answer-help"],
    promptTemplate: "findback-help-v1",
    tokenBudget: 256,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Text entry, unmeasured; eval-only license, no bundling or fetch.",
  },
  {
    modelId: "lfm2-1.2b-q4_0",
    displayName: "LFM2 1.2B (text, unmeasured)",
    modality: "text",
    upstreamRepo: "LiquidAI/LFM2-1.2B",
    fileName: "LFM2-1.2B-Q4_0.gguf",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: "LFM-1.0",
    redistribution: "benchmark-eval-only",
    runtime: "llama-cpp",
    format: "gguf",
    taskRoles: ["answer-help"],
    promptTemplate: "findback-help-v1",
    tokenBudget: 256,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Text entry, unmeasured; eval-only license, no bundling or fetch.",
  },
  {
    modelId: "lfm2-vl-450m-int4",
    displayName: "LFM2-VL 450M (vision, unmeasured)",
    modality: "vision",
    upstreamRepo: "LiquidAI/LFM2-VL-450M",
    fileName: "LFM2-VL-450M-int4.litertlm",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: "LFM-1.0",
    redistribution: "benchmark-eval-only",
    runtime: "litert-lm",
    format: "litertlm",
    taskRoles: ["analyze-image"],
    promptTemplate: "findback-vision-v1",
    tokenBudget: 512,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Vision entry, unmeasured; eval-only license, no bundling or fetch.",
  },
  {
    modelId: "lfm2-vl-1.6b-int4",
    displayName: "LFM2-VL 1.6B (vision, unmeasured)",
    modality: "vision",
    upstreamRepo: "LiquidAI/LFM2-VL-1.6B",
    fileName: "LFM2-VL-1.6B-int4.litertlm",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: "LFM-1.0",
    redistribution: "benchmark-eval-only",
    runtime: "litert-lm",
    format: "litertlm",
    taskRoles: ["analyze-image"],
    promptTemplate: "findback-vision-v1",
    tokenBudget: 512,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Vision entry, unmeasured; eval-only license, no bundling or fetch.",
  },
  {
    modelId: "qwen3-vl-2b-instruct-int4",
    displayName: "Qwen3-VL 2B Instruct (vision, unmeasured)",
    modality: "vision",
    upstreamRepo: "Qwen/Qwen3-VL-2B-Instruct",
    fileName: "Qwen3-VL-2B-Instruct-int4.litertlm",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: "Apache-2.0",
    redistribution: "pending-verification",
    runtime: "litert-lm",
    format: "litertlm",
    taskRoles: ["analyze-image"],
    promptTemplate: "findback-vision-v1",
    tokenBudget: 512,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Vision entry, unmeasured; no bundle/fetch until pins are verified.",
  },
  {
    modelId: "minicpm-2b-text",
    displayName: "MiniCPM 2B (text, unmeasured, pending validation)",
    modality: "text",
    upstreamRepo: "pending-verification",
    fileName: "pending-verification",
    revision: PENDING_VERIFICATION,
    sha256: PENDING_VERIFICATION,
    artifactBytes: null,
    license: PENDING_VERIFICATION,
    redistribution: "pending-verification",
    runtime: "llama-cpp",
    format: "gguf",
    taskRoles: ["answer-help"],
    promptTemplate: "findback-help-v1",
    tokenBudget: 256,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: false,
    labNote: "Text entry, unmeasured; inclusion pending upstream source validation.",
  },
  {
    modelId: "smolvlm2-500M-vision",
    displayName: "SmolVLM2 500M (vision baseline entry, unmeasured)",
    modality: "vision",
    upstreamRepo: "litert-community/SmolVLM2-500M",
    fileName: "SmolVLM2-500M.litertlm",
    revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c",
    sha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
    artifactBytes: null,
    license: "Apache-2.0",
    redistribution: "redistributable",
    runtime: "litert-lm",
    format: "litertlm",
    taskRoles: ["analyze-image", "ground-objects"],
    promptTemplate: "findback-vision-v1",
    tokenBudget: 512,
    thinkingMode: "disabled",
    measured: false,
    pinsVerified: true,
    labNote: "Vision baseline entry, unmeasured; byte size confirmed at device-run time.",
  },
];

export function benchmarkCandidateFor(modelId: string): BenchmarkCandidateMeta | undefined {
  return BENCHMARK_CANDIDATES.find((candidate) => candidate.modelId === modelId);
}
