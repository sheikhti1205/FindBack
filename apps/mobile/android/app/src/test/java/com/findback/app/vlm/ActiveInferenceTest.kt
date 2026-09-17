package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ActiveInferenceTest {

    @Test fun beginRejectsSecondInferenceWhileActive() {
        val controller = ActiveInferenceController()
        val first = controller.begin()
        assertNotNull(first)
        assertNull(controller.begin())
    }

    @Test fun cancelDoesNotUnlockEarly() {
        val controller = ActiveInferenceController()
        val token = controller.begin()!!
        controller.markNativeRunning(token, true)
        controller.cancel()
        // Token stays active and native still flagged running: the mutex
        // must stay held until the native call returns.
        assertTrue(controller.isActive())
        assertTrue(controller.isNativeRunning())
        assertNull(controller.begin())
    }

    @Test fun cancelledResultIsStaleAndMustBeIgnored() {
        val controller = ActiveInferenceController()
        val token = controller.begin()!!
        controller.markNativeRunning(token, true)
        controller.cancel()
        assertTrue(controller.isCancelled(token))
    }

    @Test fun finishNativeClearsActiveAndReportsDeferredRelease() {
        val controller = ActiveInferenceController()
        val token = controller.begin()!!
        controller.markNativeRunning(token, true)
        controller.cancel()
        assertTrue(controller.deferEngineRelease())
        assertTrue(controller.finishNative(token))
        assertFalse(controller.isActive())
        assertFalse(controller.isNativeRunning())
        // Next inference may begin with a fresh request id.
        val next = controller.begin()!!
        assertEquals(token.requestId + 1, next.requestId)
        assertFalse(controller.isCancelled(next))
    }

    @Test fun staleTokenFinishNeverClearsNewInference() {
        val controller = ActiveInferenceController()
        val stale = controller.begin()!!
        controller.markNativeRunning(stale, true)
        controller.finishNative(stale)
        val current = controller.begin()!!
        // A late native return for the old token must not clear the new one.
        assertFalse(controller.finishNative(stale))
        assertTrue(controller.isActive())
        controller.markNativeRunning(current, true)
        assertFalse(controller.finishNative(current))
        assertFalse(controller.isActive())
    }

    @Test fun deferWithoutRunningNativeReleasesImmediately() {
        val controller = ActiveInferenceController()
        assertFalse(controller.deferEngineRelease())
        val token = controller.begin()!!
        // Begun but native not yet running: no deferral, release now.
        assertFalse(controller.deferEngineRelease())
        controller.markNativeRunning(token, true)
        assertTrue(controller.deferEngineRelease())
    }

    @Test fun uncancelledResultResolves() {
        val controller = ActiveInferenceController()
        val token = controller.begin()!!
        controller.markNativeRunning(token, true)
        assertFalse(controller.isCancelled(token))
        controller.markNativeRunning(token, false)
        assertFalse(controller.finishNative(token))
    }
}
