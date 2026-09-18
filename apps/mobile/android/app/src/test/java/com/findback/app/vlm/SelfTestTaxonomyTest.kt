package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * WP2 (audit #25): self-test failures are classified, not flattened into a
 * bare GPU_UNAVAILABLE + diagnostics string. The classification travels in
 * the full GpuSelfTestResult to the UI.
 */
class SelfTestTaxonomyTest {

    @Test
    fun failure_wiresRoundTrip() {
        assertEquals(SelfTestFailure.INPUT_ERROR, SelfTestFailure.fromWire("INPUT_ERROR"))
        assertEquals(SelfTestFailure.MODEL_RUNTIME_ERROR, SelfTestFailure.fromWire("MODEL_RUNTIME_ERROR"))
        assertEquals(SelfTestFailure.GENERATION_ERROR, SelfTestFailure.fromWire("GENERATION_ERROR"))
        assertNull(SelfTestFailure.fromWire("NOPE"))
    }

    @Test
    fun result_serializesFailureAndError() {
        val result = GpuSelfTestResult(
            state = GpuSelfTestState.GPU_UNAVAILABLE,
            error = "decode failed",
            failure = SelfTestFailure.INPUT_ERROR
        )
        val obj = result.toJSObject()
        assertEquals("GPU_UNAVAILABLE", obj.getString("state"))
        assertEquals("decode failed", obj.getString("error"))
        assertEquals("INPUT_ERROR", obj.getString("failure"))
    }

    @Test
    fun result_omitsFailureAndErrorWhenAbsent() {
        val obj = GpuSelfTestResult(GpuSelfTestState.GPU_AVAILABLE).toJSObject()
        assertEquals("GPU_AVAILABLE", obj.getString("state"))
        assertFalse(obj.has("error"))
        assertFalse(obj.has("failure"))
    }

    @Test
    fun outcome_successHasNoFailure() {
        val outcome = SelfTestOutcome(success = true, diagnostics = listOf("ok"))
        assertTrue(outcome.success)
        assertNull(outcome.failure)
    }
}
