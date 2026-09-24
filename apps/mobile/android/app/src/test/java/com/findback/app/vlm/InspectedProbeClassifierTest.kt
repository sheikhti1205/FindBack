package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Probe outcome gating: only a real OutOfMemoryError or a distinctly
 * identified native allocation failure qualifies for lowMemory; every
 * other error is incompatible and cannot be kept.
 */
class InspectedProbeClassifierTest {

    @Test
    fun outOfMemoryQualifiesForKeepAnyway() {
        val result = InspectedProbeClassifier.classifyFailure(OutOfMemoryError("Java heap space"))
        assertFalse(result.ready)
        assertTrue(result.lowMemory)
        assertEquals("LOW_MEMORY", result.reason)
        assertTrue(InspectedProbeClassifier.isKeepable(result))
    }

    @Test
    fun distinctNativeAllocFailureQualifiesButGenericErrorsDoNot() {
        val native = InspectedProbeClassifier.classifyFailure(RuntimeException("mmap failed: ENOMEM (out of memory)"))
        assertTrue(native.lowMemory)
        assertTrue(InspectedProbeClassifier.isKeepable(native))

        val generic = InspectedProbeClassifier.classifyFailure(IllegalStateException("Unsupported LiteRT operator FOO"))
        assertFalse(generic.ready)
        assertFalse(generic.lowMemory)
        assertEquals("INCOMPATIBLE", generic.reason)
        assertFalse(InspectedProbeClassifier.isKeepable(generic))
    }

    @Test
    fun successRequiresNonemptyGeneration() {
        val empty = InspectedProbeClassifier.classifySuccess(
            loadMs = 10, inferenceMs = 20, memoryBeforeMb = 100, observedPeakMb = 110, nonemptyOutput = false
        )
        assertFalse(empty.ready)
        assertFalse(empty.lowMemory)
        val ok = InspectedProbeClassifier.classifySuccess(
            loadMs = 10, inferenceMs = 20, memoryBeforeMb = 100, observedPeakMb = 110, nonemptyOutput = true
        )
        assertTrue(ok.ready)
        assertFalse(ok.lowMemory)
        assertTrue(InspectedProbeClassifier.isKeepable(ok))
    }
}
