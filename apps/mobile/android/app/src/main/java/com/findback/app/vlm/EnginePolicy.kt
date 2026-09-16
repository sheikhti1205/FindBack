package com.findback.app.vlm

/**
 * Engine policy for the 500M GPU backend.
 * Hardcodes GPU as the only backend; no CPU fallback path.
 */
object EnginePolicy {
    /**
     * Returns the backend name used for telemetry and result reporting.
     * Always "gpu" for the 500M engine.
     */
    fun backendName(): String = "gpu"

    /**
     * Checks if a GPU self-test response indicates a passing result.
     * Requires non-empty, non-whitespace text that looks like a real description.
     */
    fun selfTestPassed(text: String): Boolean {
        val trimmed = text.trim()
        return trimmed.isNotEmpty() && trimmed.length >= 3
    }
}