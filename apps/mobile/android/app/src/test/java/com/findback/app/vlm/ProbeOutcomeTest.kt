package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ProbeOutcomeTest {
    @Test fun readRequiresFullInferenceNotJustDelegateCreation() {
        assertEquals(VlmState.GPU_UNAVAILABLE, ProbePolicy.outcome(delegateApplied = true, fullInferenceCompleted = false))
        assertEquals(VlmState.GPU_UNAVAILABLE, ProbePolicy.outcome(delegateApplied = false, fullInferenceCompleted = false))
        assertEquals(VlmState.READY_GPU, ProbePolicy.outcome(delegateApplied = true, fullInferenceCompleted = true))
    }
    @Test fun unavailableAlwaysCarriesTheRuntimeReasonCode() {
        assertEquals(VlmErrorCode.GPU_UNAVAILABLE_ON_CURRENT_RUNTIME, ProbePolicy.reasonFor(VlmState.GPU_UNAVAILABLE))
        assertNull(ProbePolicy.reasonFor(VlmState.READY_GPU))
    }
}