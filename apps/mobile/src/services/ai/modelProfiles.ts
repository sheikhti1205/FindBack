/** Retained local tool facts and generic output-normalization contracts. */
import type { AiErrorClass } from "./testing/FakeAiProvider";
import type { NarrowOp } from "./types";

export type ModelRuntime = "needle-cact" | "cloud";
export type ModelFormat = "cact" | "remote";
export type ModelMaturity = "default" | "experimental" | "eval-only";
export type StructuredOutputStrategy = "single-json-object" | "thought-envelope-then-prose" | "prose-answer";

/** Optional provider-specific reasoning envelope; never stripped globally. */
export interface ThoughtEnvelope {
  readonly openMarker: string;
  readonly closeMarker: string;
}

export interface LoopPolicy {
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
  /** Descriptive only. Production serving roles belong to ModelDescriptor. */
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
  readonly license?: string;
  readonly catalogOnly?: boolean;
}

// USE is the bundled semantic-matching incumbent, owned by its native embedder.
// Needle remains opt-in; this profile is not a general assistant or photo model.
export const MODEL_PROFILES: readonly ModelProfile[] = [{
  id: "needle3-cact-l20",
  corpusLabel: "Needle3-cact-l20",
  modelSha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
  runtime: "needle-cact",
  format: "cact",
  revision: "c7c415a3d1b3d929014bc6e866d51ebb971f7089",
  quantization: "cactus-quants (embedding=4,mhc=4,default=2, 8-bit kv/activations)",
  supportsText: true, supportsVision: false, supportsGeneral: false,
  roles: ["extract-report-fields"], maturity: "experimental",
  roleNotes: "Opt-in structured extraction and text embeddings. Serving roles are descriptor-owned. Apache-2.0 conditions apply; native telemetry is disabled.",
  defaultTemperature: 0,
  maxOutputTokensText: 256,
  stopSequences: [],
  structuredOutputStrategy: "single-json-object",
  retryLimit: 1,
  loopPolicy: { owner: "task-22", errorClass: "LOOP_DETECTED" },
}];

export function profileFor(id: string): ModelProfile | undefined {
  return MODEL_PROFILES.find((profile) => profile.id === id);
}
