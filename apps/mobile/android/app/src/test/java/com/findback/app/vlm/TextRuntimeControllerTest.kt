package com.findback.app.vlm

import java.util.concurrent.CountDownLatch
import kotlin.concurrent.thread
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TextRuntimeControllerTest {

    private class Harness(
        val host: FakeQwenTextHost = FakeQwenTextHost(),
        var factoryCalls: Int = 0,
        var factoryFailure: Throwable? = null,
        var installed: Boolean = true
    ) {
        var engine: QwenTextEngine? = null
        val controller = TextRuntimeController(
            engineFactory = {
                factoryCalls++
                factoryFailure?.let { throw it }
                if (!installed) return@TextRuntimeController null
                QwenTextEngine(hostFactory = { host }, diagCacheDir = null).also { engine = it }
            },
            isModelInstalled = { installed }
        )
    }

    private fun awaitRunning(harness: Harness) {
        val deadline = System.currentTimeMillis() + 10_000
        while (!harness.controller.isNativeRunning() && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertTrue(harness.controller.isNativeRunning(), "generation should be running")
    }

    @Test fun generateRejectsWrongModelIdsWithoutTouchingRuntime() {
        val harness = Harness()
        val rejected = listOf(
            null, "", "smolvlm2-500m", "smolvlm-256m",
            "qwen3-0.6b-litert-dynamic-int4", "qwen3-0.6b-dynamic-int4", "QWEN3-0.6B"
        )
        for (modelId in rejected) {
            val outcome = harness.controller.generateText(modelId, "hello", 64, 0.1f)
            assertTrue(outcome is TextGenerateOutcome.Err, "modelId=${modelId ?: "<null>"}")
            assertEquals(
                TextRuntimeController.CODE_UNSUPPORTED_MODEL,
                (outcome as TextGenerateOutcome.Err).code
            )
        }
        assertEquals(0, harness.factoryCalls)
        assertFalse(harness.controller.isReady())
    }

    @Test fun selfTestRejectsWrongModelIds() {
        val harness = Harness()
        val result = harness.controller.runSelfTest("smolvlm2-500m", "probe")
        assertFalse(result.ready)
        assertEquals(TextRuntimeController.STATE_UNSUPPORTED, result.state)
        assertEquals(0, harness.factoryCalls)
    }

    @Test fun missingModelFileBlocksGeneration() {
        val harness = Harness(installed = false)
        val outcome = harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        assertTrue(outcome is TextGenerateOutcome.Err)
        assertEquals(TextRuntimeController.CODE_MODEL_NOT_INSTALLED, outcome.code)
        assertFalse(harness.controller.isReady())
        assertFalse(harness.controller.status().modelFilePresent)
    }

    @Test fun initFailureBlocksReadiness() {
        val harness = Harness()
        harness.host.initFailure = IllegalStateException("no runtime")
        val outcome = harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        assertTrue(outcome is TextGenerateOutcome.Err)
        assertEquals(TextRuntimeController.CODE_MODEL_RUNTIME_ERROR, outcome.code)
        assertFalse(harness.controller.isReady())
    }

    @Test fun successMarksReadyAndReportsDiagnostics() {
        val harness = Harness()
        harness.host.reply = "an answer"
        val outcome = harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        assertTrue(outcome is TextGenerateOutcome.Ok)
        assertEquals("an answer", (outcome as TextGenerateOutcome.Ok).text)
        assertEquals("gpu", outcome.backend)
        assertTrue(harness.controller.isReady())
        val status = harness.controller.status()
        assertEquals("qwen3-0.6b", status.modelId)
        assertTrue(status.ready)
        assertFalse(status.nativeRunning)
        assertEquals("gpu", status.backend)
        assertTrue(status.modelFilePresent)
    }

    @Test fun secondGenerateWhileRunningIsBusy() {
        val harness = Harness()
        harness.host.generateGate = CountDownLatch(1)
        var first: TextGenerateOutcome? = null
        val worker = thread { first = harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f) }
        try {
            awaitRunning(harness)
            val second = harness.controller.generateText("qwen3-0.6b", "again", 64, 0.1f)
            assertTrue(second is TextGenerateOutcome.Err)
            assertEquals(TextRuntimeController.CODE_BUSY, second.code)
        } finally {
            harness.host.generateGate?.countDown()
            worker.join(10_000)
        }
        assertTrue(first is TextGenerateOutcome.Ok)
    }

    @Test fun cancelDuringGenerateYieldsCancelled() {
        val harness = Harness()
        harness.host.generateGate = CountDownLatch(1)
        var outcome: TextGenerateOutcome? = null
        val worker = thread { outcome = harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f) }
        try {
            awaitRunning(harness)
            harness.controller.cancel()
            harness.host.generateGate?.countDown()
            worker.join(10_000)
        } finally {
            harness.host.generateGate?.countDown()
            worker.join(10_000)
        }
        assertTrue(outcome is TextGenerateOutcome.Err)
        assertEquals(TextRuntimeController.CODE_CANCELLED, (outcome as TextGenerateOutcome.Err).code)
    }

    @Test fun releaseDisposesEngineAndClearsReadiness() {
        val harness = Harness()
        harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        assertTrue(harness.controller.isReady())
        harness.controller.release()
        assertFalse(harness.controller.isReady())
        assertEquals(1, harness.host.closeCount)
        assertFalse(harness.controller.status().ready)
    }

    @Test fun releaseWhileNativeRunningDefersClose() {
        val harness = Harness()
        harness.host.generateGate = CountDownLatch(1)
        var outcome: TextGenerateOutcome? = null
        val worker = thread { outcome = harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f) }
        try {
            awaitRunning(harness)
            harness.controller.release()
            assertEquals(0, harness.host.closeCount)
            harness.host.generateGate?.countDown()
            worker.join(10_000)
        } finally {
            harness.host.generateGate?.countDown()
            worker.join(10_000)
        }
        assertEquals(1, harness.host.closeCount)
        assertFalse(harness.controller.isReady())
        assertTrue(outcome is TextGenerateOutcome.Err)
        assertEquals(TextRuntimeController.CODE_CANCELLED, (outcome as TextGenerateOutcome.Err).code)
    }

    @Test fun selfTestGatesActivationReadiness() {
        val harness = Harness()
        harness.host.reply = "a useful description"
        val ready = harness.controller.runSelfTest("qwen3-0.6b", "probe")
        assertTrue(ready.ready)
        assertEquals(TextRuntimeController.STATE_READY, ready.state)
        assertTrue(ready.diagnostics.isNotEmpty())

        val failing = Harness(FakeQwenTextHost(reply = "  "))
        val notReady = failing.controller.runSelfTest("qwen3-0.6b", "probe")
        assertFalse(notReady.ready)
        assertEquals(TextRuntimeController.STATE_UNAVAILABLE, notReady.state)
        assertEquals(SelfTestFailure.GENERATION_ERROR, notReady.failure)
    }

    @Test fun blankPromptSurfacesGenerationError() {
        val harness = Harness()
        val outcome = harness.controller.generateText("qwen3-0.6b", "  ", 64, 0.1f)
        assertTrue(outcome is TextGenerateOutcome.Err)
        assertEquals(TextRuntimeController.CODE_GENERATION_ERROR, outcome.code)
    }

    @Test fun factoryThrowingSurfacesRuntimeError() {
        val harness = Harness(factoryFailure = IllegalStateException("store broken"))
        val outcome = harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        assertTrue(outcome is TextGenerateOutcome.Err)
        assertEquals(TextRuntimeController.CODE_MODEL_RUNTIME_ERROR, outcome.code)
    }

    @Test fun generationFlagClearsAfterSettle() {
        val harness = Harness()
        harness.controller.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        assertFalse(harness.controller.isNativeRunning())
        harness.controller.generateText("qwen3-0.6b", "again", 64, 0.1f)
        assertFalse(harness.controller.isNativeRunning())
        assertEquals(1, harness.factoryCalls)
        assertEquals(1, harness.host.initCount)
    }
}
