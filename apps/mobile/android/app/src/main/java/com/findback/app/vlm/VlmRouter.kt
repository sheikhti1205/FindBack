package com.findback.app.vlm

/**
 * Retry plan for VLM model failures.
 * @param reinitSame Whether to reinitialize the same model.
 * @param switchTo The model to switch to after reinit, or null to fail closed.
 */
data class RetryPlan(
    val reinitSame: Boolean,
    val switchTo: VlmModelId?
)

sealed class AnalysisSelection {
    data class Ready(val modelId: VlmModelId) : AnalysisSelection()
    data class Unsupported(val reason: String) : AnalysisSelection()
}

/**
 * Router for selecting VLM models based on backend mode and model states.
 * GPU-strict: only READY_GPU is considered usable. No CPU branch anywhere.
 */
object VlmRouter {

    /**
     * Chooses the best model for the given backend mode and model states.
     * @param mode The backend mode (AUTO, FAST, QUALITY).
     * @param states Map of model IDs to their current states.
     * @return The chosen model ID, or null if no suitable model is available.
     */
    fun choose(mode: BackendMode, states: Map<VlmModelId, VlmState>): VlmModelId? {
        return when (mode) {
            BackendMode.AUTO -> chooseAuto(states)
            BackendMode.FAST -> chooseFast(states)
            BackendMode.QUALITY -> chooseQuality(states)
        }
    }

    fun selectForAnalysis(mode: BackendMode, states: Map<VlmModelId, VlmState>): AnalysisSelection {
        return when (val modelId = choose(mode, states)) {
            null -> AnalysisSelection.Unsupported("No READY_GPU model available for mode ${mode.wire}")
            VlmModelId.SMOLVLM_256M -> AnalysisSelection.Unsupported("smolvlm-256m does not support complete image generation")
            VlmModelId.SMOLVLM2_500M -> AnalysisSelection.Ready(modelId)
        }
    }

    private fun chooseAuto(states: Map<VlmModelId, VlmState>): VlmModelId? {
        // Prefer 500M if READY_GPU, then 256M if READY_GPU
        if (states[VlmModelId.SMOLVLM2_500M] == VlmState.READY_GPU) {
            return VlmModelId.SMOLVLM2_500M
        }
        if (states[VlmModelId.SMOLVLM_256M] == VlmState.READY_GPU) {
            return VlmModelId.SMOLVLM_256M
        }
        return null
    }

    private fun chooseFast(states: Map<VlmModelId, VlmState>): VlmModelId? {
        // FAST only uses 256M model
        if (states[VlmModelId.SMOLVLM_256M] == VlmState.READY_GPU) {
            return VlmModelId.SMOLVLM_256M
        }
        return null
    }

    private fun chooseQuality(states: Map<VlmModelId, VlmState>): VlmModelId? {
        // QUALITY only uses 500M model
        if (states[VlmModelId.SMOLVLM2_500M] == VlmState.READY_GPU) {
            return VlmModelId.SMOLVLM2_500M
        }
        return null
    }

    /**
     * Returns a retry plan for the first failure of a model.
     * Always attempts to reinitialize the same model once.
     * @param mode The backend mode.
     * @param failed The model that failed.
     * @param states Current states of all models.
     * @return RetryPlan with reinitSame = true, switchTo = null.
     */
    fun retryPlan(mode: BackendMode, failed: VlmModelId, states: Map<VlmModelId, VlmState>): RetryPlan {
        return RetryPlan(reinitSame = true, switchTo = null)
    }

    /**
     * Returns a retry plan after reinitialization of the same model has been attempted.
     * For AUTO: if the other model is READY_GPU, switch to it; otherwise fail closed.
     * For FAST/QUALITY: always fail closed (no model switching).
     * @param mode The backend mode.
     * @param failed The model that failed even after reinit.
     * @param states Current states of all models.
     * @return RetryPlan with reinitSame = false, and switchTo set accordingly.
     */
    fun retryPlanAfterReinit(mode: BackendMode, failed: VlmModelId, states: Map<VlmModelId, VlmState>): RetryPlan {
        return when (mode) {
            BackendMode.AUTO -> {
                val otherModel = when (failed) {
                    VlmModelId.SMOLVLM2_500M -> VlmModelId.SMOLVLM_256M
                    VlmModelId.SMOLVLM_256M -> VlmModelId.SMOLVLM2_500M
                }
                if (states[otherModel] == VlmState.READY_GPU) {
                    RetryPlan(reinitSame = false, switchTo = otherModel)
                } else {
                    RetryPlan(reinitSame = false, switchTo = null)
                }
            }
            BackendMode.FAST, BackendMode.QUALITY -> {
                RetryPlan(reinitSame = false, switchTo = null)
            }
        }
    }
}
