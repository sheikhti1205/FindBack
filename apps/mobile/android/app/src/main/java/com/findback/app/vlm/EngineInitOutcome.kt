package com.findback.app.vlm

/**
 * Taxonomy for 500M engine acquisition (TS contract): a missing model file
 * (MODEL_MISSING) is distinct from an engine/GPU init failure
 * (RUNTIME_ERROR). Init failures must never collapse into "not installed".
 */
sealed interface EngineInitOutcome {
    data object ModelMissing : EngineInitOutcome
    data class RuntimeError(val message: String?) : EngineInitOutcome
    data object Ready : EngineInitOutcome
}

internal fun classifyEngineInit(modelFileExists: Boolean, initSucceeded: Boolean, message: String? = null): EngineInitOutcome {
    if (!modelFileExists) return EngineInitOutcome.ModelMissing
    if (!initSucceeded) return EngineInitOutcome.RuntimeError(message)
    return EngineInitOutcome.Ready
}
