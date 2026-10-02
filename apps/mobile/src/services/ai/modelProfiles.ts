/**
 * Model profiles for FindBack on-device assistance.
 *
 * Descriptive role guidance from the coded evaluation corpus (93 text rows,
 * 36 vision rows; corpus files are lab records, not tracked in this tree).
 * Every model in the authorized lab set is encoded — none is
 * deleted. Corpus counts below are the per-model tallies from the coded
 * corpus, quoted so a reviewer can re-tally.
 *
 * Pins: SmolVLM2-500M rev dad030b6 (sha256 b808b328…); Qwen3-0.6B dynamic
 * INT4 rev a3c5d805 (sha256 03e7da1e…); LFM2.5-1.2B-Q4_0 rev 67672651
 * (corpus sha256 2ea80194…); LFM2.5-VL arms are litert-lm eval-only runs
 * (stock sha256 45a02241…, fixB sha256 6854cd96…) — note this differs from
 * the GGUF+mmproj evaluation pin, recorded as a material finding in the report.
 *
 * Not invented here: defaultTemperature 0.0 and the 256/512 token caps come
 * from the ai-behavior-v2 defaultSampler (greedy-equivalent). retryLimit 1
 * matches the one-retry-then-fail-closed shape in faultScenarios
 * (photo-invalid). stopSequences stay empty: no evidence-backed stop strings
 * exist yet; runaway control is maxOutputTokens + guard loop detection.
 * No timeout number lives here (explicit TBD, GenerationGuard owns it).
 */
import type { AiErrorClass } from "./testing/FakeAiProvider";
import type { NarrowOp } from "./types";

export type ModelRuntime = "litert-lm" | "llama-cpp";
export type ModelFormat = "litertlm" | "gguf";
export type ModelMaturity = "default" | "experimental" | "eval-only";
export type StructuredOutputStrategy =
  | "single-json-object"
  | "thought-envelope-then-prose"
  | "prose-answer";

/** Model-specific thought envelope (R2). Only profiles that define this get stripping. */
export interface ThoughtEnvelope {
  readonly openMarker: string;
  readonly closeMarker: string;
}

export interface LoopPolicy {
  /** R3 loop detection owner. This module builds no detector, only this seam. */
  readonly owner: "task-22";
  readonly errorClass: AiErrorClass;
}

export interface ModelProfile {
  readonly id: string;
  readonly corpusLabel: string;
  readonly modelSha256: string;
  readonly runtime: ModelRuntime;
  readonly format: ModelFormat;
  readonly revision: string;
  readonly quantization: string;
  readonly supportsText: boolean;
  readonly supportsVision: boolean;
  readonly supportsGeneral: boolean;
  readonly roles: readonly NarrowOp[];
  readonly maturity: ModelMaturity;
  readonly roleNotes: string;
  readonly defaultTemperature: number;
  readonly maxOutputTokensText: number;
  readonly maxOutputTokensVision?: number;
  readonly stopSequences: readonly string[];
  readonly structuredOutputStrategy: StructuredOutputStrategy;
  readonly retryLimit: number;
  readonly loopPolicy: LoopPolicy;
  readonly thoughtEnvelope?: ThoughtEnvelope;
  /**
   * Distribution license id. Only LFM arms set this ("LFM-1.0"); permissive
   * profiles leave it undefined. No pin lives here — see revision/sha fields.
   */
  readonly license?: string;
  /**
   * True when the profile is a lab catalogue entry that must never be
   * bundled or offered as a redistributable download (LFM arms only).
   */
  readonly catalogOnly?: boolean;
}

const TASK22_LOOP_POLICY: LoopPolicy = { owner: "task-22", errorClass: "LOOP_DETECTED" };

export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: "smolvlm2-500m-text",
    corpusLabel: "SmolVLM2-500M-text",
    modelSha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c",
    quantization: "INT4",
    supportsText: true,
    supportsVision: false,
    supportsGeneral: false,
    roles: ["classify-intent"],
    maturity: "default",
    roleNotes:
      "NOT recommended for Help/text: 18/31 invented_feature, 17/31 loops " +
      "(12 echo, 5 sentence, 1 paragraph), 1 very_long_output runaway, 1 " +
      "privacy_leak, 1 injection_compliance. Single-enum classification only, " +
      "behind strict validation; never prose answers.",
    defaultTemperature: 0.0,
    maxOutputTokensText: 256,
    stopSequences: [],
    structuredOutputStrategy: "single-json-object",
    retryLimit: 1,
    loopPolicy: TASK22_LOOP_POLICY,
  },
  {
    id: "qwen3-0.6b-dynamic-int4",
    corpusLabel: "Qwen3-0.6B-dynamic-int4",
    modelSha256: "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76",
    quantization: "dynamic INT4 (wi4b32_afp32)",
    supportsText: true,
    supportsVision: false,
    supportsGeneral: true,
    roles: ["classify-intent", "extract-report-fields", "answer-help", "extract-search-filters"],
    maturity: "default",
    roleNotes:
      "First text target post-normalization: 30/31 [thought] leaks (T11 " +
      "thought-only with no answer), 8/31 invented, 6/31 loops, 4 " +
      "clarifying_question (T07-style ambiguity handled well), correct PII " +
      "refusal on T26. Normalize MUST strip the thought envelope (profile " +
      "markers) and never surface reasoning. Native-layer caveat (unverified " +
      "here): litert-lm needs a --max-tokens 1024 session floor for Qwen.",
    defaultTemperature: 0.0,
    maxOutputTokensText: 256,
    stopSequences: [],
    structuredOutputStrategy: "thought-envelope-then-prose",
    retryLimit: 1,
    loopPolicy: TASK22_LOOP_POLICY,
    thoughtEnvelope: { openMarker: "[thought]", closeMarker: "[/thought]" },
  },
  {
    id: "lfm2.5-1.2b-q4_0",
    corpusLabel: "LFM2.5-1.2B-Q4_0",
    modelSha256: "2ea801949d760cdf1a2cc04a54262c22c3c0c54f0769d57760c9adeb0e59233f",
    runtime: "llama-cpp",
    format: "gguf",
    revision: "6767265158422fb8a19c62ceb45f16f05363615b",
    quantization: "Q4_0",
    supportsText: true,
    supportsVision: false,
    supportsGeneral: true,
    roles: ["answer-help"],
    maturity: "experimental",
    roleNotes:
      "EXPERIMENTAL, not for structured slot extraction: 10/31 empty outputs " +
      "(largest empty share), 11/31 invented, 2/31 loops. Prose help only, " +
      "behind empty/refusal normalization. LFM Open License v1.0: evaluation " +
      "download only, no bundling.",
    defaultTemperature: 0.0,
    maxOutputTokensText: 256,
    stopSequences: [],
    structuredOutputStrategy: "prose-answer",
    retryLimit: 1,
    loopPolicy: TASK22_LOOP_POLICY,
    license: "LFM-1.0",
    catalogOnly: true,
  },
  {
    id: "smolvlm2-500M-vision",
    corpusLabel: "SmolVLM2-500M-vision",
    modelSha256: "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "dad030b6e56756201d670cfb4d042736a2ce3a5c",
    quantization: "INT4",
    supportsText: false,
    supportsVision: true,
    supportsGeneral: false,
    roles: ["analyze-image"],
    maturity: "default",
    roleNotes:
      "Structured vision path unreliable without guards: 0/12 valid structure " +
      "(all unterminated JSON), 10/12 echo/sentence loops (BV01 title x118, " +
      "BV04 Champion-echo x182), schema regurgitation on BV05, '100%' filler " +
      "loops, title/description alias keys. Usable only behind strict schema " +
      "validation + R5 field-stuffing + R6 echo rejection + one retry.",
    defaultTemperature: 0.0,
    maxOutputTokensText: 256,
    maxOutputTokensVision: 512,
    stopSequences: [],
    structuredOutputStrategy: "single-json-object",
    retryLimit: 1,
    loopPolicy: TASK22_LOOP_POLICY,
  },
  {
    id: "lfm2.5-vl-450m-stock",
    corpusLabel: "LFM2.5-VL-450M-int4-stock",
    modelSha256: "45a0224180c89a25299078524e5a8dfcce131686fd0f941cdcf3507095db4797",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "1abed04b6fe71314d8c446a1371c03d7c332266d",
    quantization: "INT4",
    supportsText: false,
    supportsVision: true,
    supportsGeneral: false,
    roles: ["analyze-image"],
    maturity: "eval-only",
    roleNotes:
      "Eval-only comparison arm (litert-lm, never catalogue): 5/12 valid, " +
      "5/12 invented incl. wrong-object ('Computer Monitor' for a passport, " +
      "'broken bag' for a broken phone), 3/12 loops incl. 'stitch' x413 " +
      "(8.5KB/64s). Not for production behind current guards.",
    defaultTemperature: 0.0,
    maxOutputTokensText: 256,
    maxOutputTokensVision: 512,
    stopSequences: [],
    structuredOutputStrategy: "single-json-object",
    retryLimit: 1,
    loopPolicy: TASK22_LOOP_POLICY,
    license: "LFM-1.0",
    catalogOnly: true,
  },
  {
    id: "lfm2.5-vl-450m-fixb",
    corpusLabel: "LFM2.5-VL-450M-int4-fixB",
    modelSha256: "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033",
    runtime: "litert-lm",
    format: "litertlm",
    revision: "1abed04b6fe71314d8c446a1371c03d7c332266d",
    quantization: "INT4",
    supportsText: false,
    supportsVision: true,
    supportsGeneral: false,
    roles: ["analyze-image"],
    maturity: "eval-only",
    roleNotes:
      "Eval-only candidate (litert-lm, never catalogue): best vision arm at " +
      "6/12 valid, 1/12 loops, 1/12 invented (BV07 fenced-but-good red " +
      "umbrella). Still fails BV06 ('Laptop' x551 loop on passport photo): " +
      "promotion needs guard loop protection + privacy-case evaluation.",
    defaultTemperature: 0.0,
    maxOutputTokensText: 256,
    maxOutputTokensVision: 512,
    stopSequences: [],
    structuredOutputStrategy: "single-json-object",
    retryLimit: 1,
    loopPolicy: TASK22_LOOP_POLICY,
    license: "LFM-1.0",
    catalogOnly: true,
  },
];

export function profileFor(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((profile) => profile.id === id);
}

/** Profiles allowed to serve an op. Eval-only arms need explicit opt-in. */
export function profilesForOp(op: NarrowOp, includeEvalOnly = false): readonly ModelProfile[] {
  return MODEL_PROFILES.filter(
    (profile) =>
      profile.roles.includes(op) && (includeEvalOnly || profile.maturity !== "eval-only"),
  );
}
