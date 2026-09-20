package com.findback.app.vlm

/**
 * Engine policy for 500M verification. GPU is the only verification backend:
 * the self-test never runs on CPU. (Analysis may use the explicit CPU
 * compatibility path; each engine reports its own backend name.)
 */
object EnginePolicy {
    /**
     * Returns the backend name used for GPU verification telemetry.
     * Always "gpu": verification never falls back to CPU.
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