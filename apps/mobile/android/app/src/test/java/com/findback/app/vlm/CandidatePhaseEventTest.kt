package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * UX-01 candidate phases: model-identity-correct event serialization.
 *
 * Candidates must never be reported under a dedicated [VlmModelId]; the
 * event carries the catalogue `entryId` string. Phase present means
 * inference is active, phase absent means terminal/idle (mirrors the
 * dedicated `inferenceState` contract). Never a fabricated percent.
 */
class CandidatePhaseEventTest {

    @Test
    fun phaseEventCarriesEntryIdAndPhaseWires() {
        val event = CandidateInferenceStateEvent(
            entryId = "lfm2.5-vl-450m",
            state = VlmState.READY_GPU,
            phase = CandidateInferencePhase.RUNNING
        )
        val obj = event.toJSObject()
        assertEquals("lfm2.5-vl-450m", obj.getString("entryId"))
        assertFalse(obj.has("modelId"), "candidate event must not use the dedicated modelId key")
        assertEquals("RUNNING", obj.getString("phase"))
        assertEquals("READY_GPU", obj.getString("state"))
        assertFalse(obj.has("progress"), "no fabricated percent is ever emitted")
    }

    @Test
    fun allPhasesHaveDistinctWires() {
        val wires = CandidateInferencePhase.values().map { it.wire }
        assertEquals(
            listOf("LOADING_MODEL", "PREPARING_IMAGE", "RUNNING", "POSTPROCESSING"),
            wires
        )
    }

    @Test
    fun terminalSuccessEventIsPhaseless() {
        val obj = CandidateInferenceStateEvent(
            entryId = "qwen3-0.6b-litert-int8",
            state = VlmState.READY_GPU
        ).toJSObject()
        assertFalse(obj.has("phase"), "terminal event returns listeners to idle")
        assertEquals("qwen3-0.6b-litert-int8", obj.getString("entryId"))
    }

    @Test
    fun terminalErrorEventCarriesCode() {
        val obj = CandidateInferenceStateEvent(
            entryId = "lfm2.5-vl-450m",
            state = VlmState.RUNTIME_ERROR,
            error = "CANCELLED"
        ).toJSObject()
        assertFalse(obj.has("phase"))
        assertEquals("CANCELLED", obj.getString("error"))
        assertEquals("RUNTIME_ERROR", obj.getString("state"))
    }

    @Test
    fun candidateBackendWireIsUnknown() {
        // AI-06/supervisor: the requested backend is not observed delegation.
        assertEquals("unknown", CANDIDATE_BACKEND_WIRE)
    }
}
