package com.findback.app.vlm

/**
 * Role-specific compatibility probe outcome for a staged
 * `PackageInspectionStore` session.
 *
 * `ready` means a bounded nonempty generation completed for the chosen
 * role. `lowMemory` means a typed memory allocation failure (only an
 * actual `OutOfMemoryError` or a distinctly identified native allocation
 * failure) — the only failure that may be kept unverified. Every other
 * error is `INCOMPATIBLE` and can never be kept.
 *
 * Metrics are observed only — never fabricated: load/inference timings
 * and memory samples are present only when actually measured around a
 * real engine run.
 */
data class ProbeResult(
    val ready: Boolean,
    val lowMemory: Boolean,
    val loadMs: Long? = null,
    val inferenceMs: Long? = null,
    val memoryBeforeMb: Long? = null,
    val observedPeakMb: Long? = null,
    val reason: String? = null
)

object InspectedProbeClassifier {
    const val CODE_INPUT_ERROR = "INPUT_ERROR"
    const val CODE_LOW_MEMORY = "LOW_MEMORY"
    const val CODE_INCOMPATIBLE = "INCOMPATIBLE"
    const val CODE_GENERATION_ERROR = "GENERATION_ERROR"

    fun validateRole(role: String?, imageUri: String?): String? {
        if (role != "Text" && role != "Vision") return CODE_INPUT_ERROR
        if (role == "Vision" && imageUri.isNullOrBlank()) return CODE_INPUT_ERROR
        return null
    }

    fun classifySuccess(
        loadMs: Long?,
        inferenceMs: Long?,
        memoryBeforeMb: Long?,
        observedPeakMb: Long?,
        nonemptyOutput: Boolean
    ): ProbeResult {
        if (!nonemptyOutput) {
            return ProbeResult(
                ready = false,
                lowMemory = false,
                loadMs = loadMs,
                inferenceMs = inferenceMs,
                memoryBeforeMb = memoryBeforeMb,
                observedPeakMb = observedPeakMb,
                reason = CODE_GENERATION_ERROR
            )
        }
        return ProbeResult(
            ready = true,
            lowMemory = false,
            loadMs = loadMs,
            inferenceMs = inferenceMs,
            memoryBeforeMb = memoryBeforeMb,
            observedPeakMb = observedPeakMb,
            reason = null
        )
    }

    fun classifyFailure(error: Throwable): ProbeResult {
        if (error is OutOfMemoryError) {
            return ProbeResult(ready = false, lowMemory = true, reason = CODE_LOW_MEMORY)
        }
        if (isDistinctNativeAllocFailure(error)) {
            return ProbeResult(ready = false, lowMemory = true, reason = CODE_LOW_MEMORY)
        }
        return ProbeResult(ready = false, lowMemory = false, reason = CODE_INCOMPATIBLE)
    }

    /**
     * Distinctly identified native allocation failures only — conservative
     * substring match on allocator-level signals. Anything else stays
     * incompatible and can never be relabeled as a memory error.
     */
    fun isDistinctNativeAllocFailure(error: Throwable): Boolean {
        val message = ((error.message ?: "") + " " + (error.cause?.message ?: "")).lowercase()
        return message.contains("mmap failed") ||
            message.contains("failed to allocate") ||
            message.contains("out of memory") ||
            message.contains("enomem") ||
            message.contains("native allocation failed") ||
            message.contains("allocation failed: no memory")
    }

    fun isKeepable(result: ProbeResult): Boolean = result.ready || result.lowMemory
}
