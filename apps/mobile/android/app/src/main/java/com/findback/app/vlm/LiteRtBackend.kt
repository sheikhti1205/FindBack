package com.findback.app.vlm

/**
 * WS3 skeleton: LiteRT stable-path backend record (comment-only, no runtime yet).
 *
 * Stable-path invariants (mirrors `src/services/ai/vision/backendSelector.ts`,
 * which is the selector of record — this file only documents the native side):
 * - CPU-first: both the vision resident (SmolVLM2-500M) and the language
 *   resident default to [LiteRtComputeBackend.CPU].
 * - GPU only after a measured on-device probe-pass record for THAT resident:
 *   a vision pass never unlocks language GPU (or vice versa). Missing,
 *   failed, future-dated, or stale evidence resolves back to CPU.
 * - Vision/language split: [VisionLanguageSplit] carries the two backends
 *   independently because vision and language have different
 *   thermal/latency budgets.
 * - Never cloud: there is no cloud member here, so an unavailable vision
 *   path cannot silently fall back to a hosted provider. The TS adapter
 *   reports it as typed `vision_unsupported` instead.
 *
 * NO NEW GRADLE DEPS YET (deliberate): a real implementation will need the
 * LiteRT artifacts (e.g. `com.google.ai.edge.litert:litert` + the GPU
 * delegate artifact) added to `app/build.gradle` by the follow-up native
 * worker, together with the `.litertlm`/`.tflite` asset wiring, the probe
 * harness that mints the evidence records, and residency management. Until
 * then this stays a pure, dependency-free record type so the skeleton
 * compiles without touching the dependency graph.
 */
enum class LiteRtComputeBackend {
    CPU,
    GPU,
}

/**
 * Independent compute backends for the two LiteRT residents.
 * Stable-path default is CPU/CPU ([STABLE_DEFAULT]).
 */
data class VisionLanguageSplit(
    val visionBackend: LiteRtComputeBackend,
    val languageBackend: LiteRtComputeBackend,
) {
    companion object {
        /** Stable-path default: both residents on CPU, no evidence needed. */
        val STABLE_DEFAULT = VisionLanguageSplit(
            visionBackend = LiteRtComputeBackend.CPU,
            languageBackend = LiteRtComputeBackend.CPU,
        )
    }
}

/**
 * Measured proof that the GPU delegate passed its probe on this device.
 * A failed probe has no representation — absence of evidence IS the
 * failure path. `measuredAtMs` is epoch millis of the measurement.
 */
data class GpuProbePassRecord(
    val passed: Boolean,
    val measuredAtMs: Long,
    /** Freshness window before the pass must be re-measured. */
    val ttlMs: Long = GPU_PROBE_PASS_TTL_MS,
    /** Advisory delegate label that passed, if recorded. */
    val delegate: String? = null,
) {
    /** True only for a passed, in-window, non-future-dated record. */
    fun isFresh(nowMs: Long = System.currentTimeMillis()): Boolean {
        if (!passed) return false
        if (measuredAtMs <= 0L || ttlMs < 0L) return false
        if (measuredAtMs > nowMs) return false
        return nowMs - measuredAtMs <= ttlMs
    }
}

const val GPU_PROBE_PASS_TTL_MS: Long = 24L * 60 * 60 * 1000

/**
 * Pure skeleton resolver (no LiteRT calls): CPU always allows; GPU
 * requires a fresh pass record and otherwise resolves back to CPU.
 */
object LiteRtBackend {
    fun resolve(requested: LiteRtComputeBackend, evidence: GpuProbePassRecord?): LiteRtComputeBackend {
        if (requested == LiteRtComputeBackend.CPU) return LiteRtComputeBackend.CPU
        return if (evidence != null && evidence.isFresh()) LiteRtComputeBackend.GPU
        else LiteRtComputeBackend.CPU
    }

    fun resolveSplit(
        requested: VisionLanguageSplit,
        visionEvidence: GpuProbePassRecord?,
        languageEvidence: GpuProbePassRecord?,
    ): VisionLanguageSplit = VisionLanguageSplit(
        visionBackend = resolve(requested.visionBackend, visionEvidence),
        languageBackend = resolve(requested.languageBackend, languageEvidence),
    )
}
