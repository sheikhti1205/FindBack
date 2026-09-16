package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class VlmRouterTest {
    @Test fun autoPrefers500Then256AndNeverCpu() {
        assertEquals(VlmModelId.SMOLVLM2_500M, VlmRouter.choose(BackendMode.AUTO,
            mapOf(VlmModelId.SMOLVLM2_500M to VlmState.READY_GPU, VlmModelId.SMOLVLM_256M to VlmState.READY_GPU)))
        assertEquals(VlmModelId.SMOLVLM_256M, VlmRouter.choose(BackendMode.AUTO,
            mapOf(VlmModelId.SMOLVLM2_500M to VlmState.CORRUPT, VlmModelId.SMOLVLM_256M to VlmState.READY_GPU)))
        assertNull(VlmRouter.choose(BackendMode.AUTO,
            mapOf(VlmModelId.SMOLVLM2_500M to VlmState.GPU_UNAVAILABLE, VlmModelId.SMOLVLM_256M to VlmState.RUNTIME_ERROR)))
    }

    @Test fun fastAndQualityNeverSwitch() {
        assertEquals(VlmModelId.SMOLVLM_256M, VlmRouter.choose(BackendMode.FAST,
            mapOf(VlmModelId.SMOLVLM_256M to VlmState.READY_GPU)))
        assertNull(VlmRouter.choose(BackendMode.FAST, mapOf(VlmModelId.SMOLVLM2_500M to VlmState.READY_GPU)))
        assertNull(VlmRouter.choose(BackendMode.QUALITY, mapOf(VlmModelId.SMOLVLM_256M to VlmState.READY_GPU)))
    }

    @Test fun autoReinitializesOnceThenSwitchesToTheOtherGpuModel() {
        val states = mapOf(VlmModelId.SMOLVLM2_500M to VlmState.READY_GPU, VlmModelId.SMOLVLM_256M to VlmState.READY_GPU)
        assertEquals(RetryPlan(true, null), VlmRouter.retryPlan(BackendMode.AUTO, VlmModelId.SMOLVLM2_500M, states))
        assertEquals(RetryPlan(false, VlmModelId.SMOLVLM_256M), VlmRouter.retryPlanAfterReinit(BackendMode.AUTO, VlmModelId.SMOLVLM2_500M, states))
    }

    @Test fun fastAndQualityReinitializeOnceThenFailClosed() {
        val states = mapOf(VlmModelId.SMOLVLM_256M to VlmState.READY_GPU)
        assertEquals(RetryPlan(true, null), VlmRouter.retryPlan(BackendMode.FAST, VlmModelId.SMOLVLM_256M, states))
        assertEquals(RetryPlan(false, null), VlmRouter.retryPlanAfterReinit(BackendMode.FAST, VlmModelId.SMOLVLM_256M, states))
    }
}