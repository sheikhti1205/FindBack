/**
 * WS3 skeleton: LiteRT backend selector (SmolVLM2-500M stable path).
 *
 * CPU-first, evidence-gated GPU, vision/language split. Pure TypeScript:
 * no I/O, no native calls, no model bytes, no network. The only backends
 * that exist here are `"cpu"` and `"gpu"` — there is deliberately no cloud
 * member, so a vision request can never silently fall back to a hosted
 * provider through this module. Unavailable vision is reported by the
 * offline adapter as typed `vision_unsupported` (see `../providers/offline`
 * `describeOfflineVision`); selection stays on-device regardless.
 *
 * Rules (stable-path invariants):
 * - CPU is always allowed and is the default for both vision and language.
 * - GPU is allowed ONLY with a fresh measured probe-pass evidence object
 *   (`GpuProbePassEvidence` with `passed: true` inside the TTL window).
 *   Missing, failed, future-dated, or stale evidence denies GPU and the
 *   selector resolves back to CPU with an explicit denial reason.
 * - Vision and language backends are configured independently
 *   (`VisionLanguageSplit`) but gated by the same evidence rule: neither
 *   side may run GPU without its own fresh pass record.
 */

export type LiteRtComputeBackend = "cpu" | "gpu";

/**
 * Independent compute backends for the two LiteRT residents. The split
 * exists because vision (SmolVLM2-500M) and language (on-device LM) have
 * different thermal/latency budgets; the stable path keeps both on CPU
 * until each side earns GPU with its own measured probe pass.
 */
export interface VisionLanguageSplit {
  readonly visionBackend: LiteRtComputeBackend;
  readonly languageBackend: LiteRtComputeBackend;
}

/** Stable-path default: both residents on CPU. */
export const DEFAULT_VISION_LANGUAGE_SPLIT: VisionLanguageSplit = {
  visionBackend: "cpu",
  languageBackend: "cpu",
} as const;

/**
 * Measured proof that the GPU delegate passed its latency/correctness
 * probe on THIS device. A failed probe is never represented here — the
 * caller simply has no evidence (pass `undefined`). `measuredAtMs` is an
 * epoch-millis timestamp of the measurement, never a schedule or an
 * estimate.
 */
export interface GpuProbePassEvidence {
  readonly backend: "gpu";
  readonly passed: true;
  /** Epoch millis when the probe pass was measured on-device. */
  readonly measuredAtMs: number;
  /** Advisory measured p95 ms/token from the probe run, if recorded. */
  readonly p95MsPerToken?: number;
  /** Advisory delegate label that passed (e.g. "gpu-stable"), if recorded. */
  readonly delegate?: string;
}

/** Freshness window for a probe pass before it must be re-measured. */
export const GPU_PROBE_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

/** Why a GPU request resolved back down to CPU. */
export type GpuDenialReason = "no-evidence" | "stale-evidence";

/**
 * True only for a well-formed, passed, in-window probe record.
 * Future-dated stamps are rejected (not evidence). Failures have no
 * representation here — absence of evidence is the failure path.
 */
export function isGpuProbeEvidenceFresh(
  evidence: GpuProbePassEvidence | undefined,
  nowMs: number = Date.now(),
  ttlMs: number = GPU_PROBE_EVIDENCE_TTL_MS,
): boolean {
  if (evidence === undefined) return false;
  if (evidence.backend !== "gpu" || evidence.passed !== true) return false;
  if (!Number.isFinite(evidence.measuredAtMs)) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs < 0) return false;
  if (evidence.measuredAtMs > nowMs) return false;
  return nowMs - evidence.measuredAtMs <= ttlMs;
}

/** Resolution of one backend request against the evidence gate. */
export interface BackendSelection {
  readonly requested: LiteRtComputeBackend;
  /** Effective backend: the request, or CPU when GPU was denied. */
  readonly selected: LiteRtComputeBackend;
  /** True only when `selected === requested` (CPU requests always allow). */
  readonly allowed: boolean;
  /** Present only when a GPU request resolved back to CPU. */
  readonly denialReason?: GpuDenialReason;
}

/**
 * Resolve one backend request. CPU always allows; GPU requires fresh
 * pass evidence and otherwise resolves to CPU with a denial reason.
 */
export function selectComputeBackend(
  requested: LiteRtComputeBackend,
  evidence: GpuProbePassEvidence | undefined,
  nowMs: number = Date.now(),
  ttlMs: number = GPU_PROBE_EVIDENCE_TTL_MS,
): BackendSelection {
  if (requested === "cpu") {
    return { requested, selected: "cpu", allowed: true };
  }
  if (evidence === undefined) {
    return {
      requested,
      selected: "cpu",
      allowed: false,
      denialReason: "no-evidence",
    };
  }
  if (!isGpuProbeEvidenceFresh(evidence, nowMs, ttlMs)) {
    return {
      requested,
      selected: "cpu",
      allowed: false,
      denialReason: "stale-evidence",
    };
  }
  return { requested, selected: "gpu", allowed: true };
}

/** Effective split plus the per-side selection records. */
export interface VisionLanguageSelection {
  readonly effective: VisionLanguageSplit;
  readonly vision: BackendSelection;
  readonly language: BackendSelection;
}

/**
 * Resolve a vision/language split. Each side is gated independently, so
 * a vision GPU pass never unlocks language GPU (or vice versa): pass
 * per-side evidence via `visionEvidence` / `languageEvidence`.
 */
export function selectVisionLanguageSplit(
  requested: VisionLanguageSplit,
  evidence: {
    readonly visionEvidence?: GpuProbePassEvidence | undefined;
    readonly languageEvidence?: GpuProbePassEvidence | undefined;
  } = {},
  nowMs: number = Date.now(),
  ttlMs: number = GPU_PROBE_EVIDENCE_TTL_MS,
): VisionLanguageSelection {
  const vision = selectComputeBackend(
    requested.visionBackend,
    evidence.visionEvidence,
    nowMs,
    ttlMs,
  );
  const language = selectComputeBackend(
    requested.languageBackend,
    evidence.languageEvidence,
    nowMs,
    ttlMs,
  );
  return {
    effective: {
      visionBackend: vision.selected,
      languageBackend: language.selected,
    },
    vision,
    language,
  };
}
