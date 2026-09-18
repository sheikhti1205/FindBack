package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * WP2a (audit #27): inference events carry real phases, never fabricated
 * percentages. Contract: phase present means active, phase absent means idle.
 */
class InferenceEventsTest {

    @Test
    fun phase_serializesToWire() {
        val obj = InferenceStateEvent(
            VlmModelId.SMOLVLM2_500M,
            VlmState.READY_GPU,
            phase = InferencePhase.RUNNING
        ).toJSObject()
        assertEquals("RUNNING", obj.getString("phase"))
        assertEquals("READY_GPU", obj.getString("state"))
        assertFalse(obj.has("progress"), "phase events must not carry fabricated progress")
    }

    @Test
    fun terminalEvent_omitsPhase() {
        val obj = InferenceStateEvent(
            VlmModelId.SMOLVLM2_500M,
            VlmState.READY_GPU
        ).toJSObject()
        assertFalse(obj.has("phase"))
        assertFalse(obj.has("progress"))
    }

    @Test
    fun phase_wiresRoundTrip() {
        assertEquals(InferencePhase.PREPARING_IMAGE, InferencePhase.fromWire("PREPARING_IMAGE"))
        assertEquals(InferencePhase.LOADING_MODEL, InferencePhase.fromWire("LOADING_MODEL"))
        assertEquals(InferencePhase.RUNNING, InferencePhase.fromWire("RUNNING"))
        assertEquals(InferencePhase.POSTPROCESSING, InferencePhase.fromWire("POSTPROCESSING"))
        assertNull(InferencePhase.fromWire("NOPE"))
    }
}
