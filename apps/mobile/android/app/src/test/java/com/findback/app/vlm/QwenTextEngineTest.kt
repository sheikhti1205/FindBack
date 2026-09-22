package com.findback.app.vlm

import kotlinx.coroutines.CancellationException
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

internal class FakeQwenTextHost(
    var reply: String = "a useful answer",
    var initFailure: Throwable? = null,
    var generateFailure: Throwable? = null,
    var generateGate: CountDownLatch? = null
) : QwenTextHost {
    var initCount = 0
    var closeCount = 0
    var cancelInFlightCount = 0
    var lastPrompt: String? = null
    var lastMaxOutputTokens: Int? = null
    var lastTemperature: Float? = null

    override fun initialize() {
        initCount++
        initFailure?.let { throw it }
    }

    override fun generate(prompt: String, maxOutputTokens: Int, temperature: Float): String {
        lastPrompt = prompt
        lastMaxOutputTokens = maxOutputTokens
        lastTemperature = temperature
        generateGate?.await(10, TimeUnit.SECONDS)
        generateFailure?.let { throw it }
        return reply
    }

    override fun cancelInFlight() {
        cancelInFlightCount++
        generateGate?.countDown()
    }

    override fun close() {
        closeCount++
    }
}

class QwenTextEngineTest {

    private fun engine(host: FakeQwenTextHost): QwenTextEngine =
        QwenTextEngine(hostFactory = { host }, diagCacheDir = null)

    @Test fun initializeSetsReadyOnlyAfterRealInit() {
        val host = FakeQwenTextHost()
        val engine = engine(host)
        assertFalse(engine.isReady)
        engine.initialize()
        assertTrue(engine.isReady)
        engine.initialize()
        assertEquals(1, host.initCount)
    }

    @Test fun initializeFailureLeavesNotReady() {
        val host = FakeQwenTextHost(initFailure = IllegalStateException("no runtime"))
        val engine = engine(host)
        assertFailsWith<IllegalStateException> { engine.initialize() }
        assertFalse(engine.isReady)
        assertEquals(1, host.closeCount)
    }

    @Test fun generateBeforeInitFailsClosed() {
        val engine = engine(FakeQwenTextHost())
        assertFailsWith<IllegalStateException> {
            engine.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        }
    }

    @Test fun generateRejectsWrongModelIdEvenWhenReady() {
        val host = FakeQwenTextHost()
        val engine = engine(host)
        engine.initialize()
        for (modelId in listOf(null, "", "smolvlm2-500m", "qwen3-0.6b-litert-dynamic-int4")) {
            assertFailsWith<IllegalArgumentException>("modelId=${modelId ?: "<null>"}") {
                engine.generateText(modelId, "hello", 64, 0.1f)
            }
        }
        assertNull(host.lastPrompt)
    }

    @Test fun generateReturnsHostTextWithRequestParams() {
        val host = FakeQwenTextHost(reply = "an answer")
        val engine = engine(host)
        engine.initialize()
        assertEquals("an answer", engine.generateText("qwen3-0.6b", "hello", 64, 0.2f))
        assertEquals("hello", host.lastPrompt)
        assertEquals(64, host.lastMaxOutputTokens)
        assertEquals(0.2f, host.lastTemperature)
    }

    @Test fun generateRejectsBlankPromptAndBadTokenCount() {
        val engine = engine(FakeQwenTextHost())
        engine.initialize()
        assertFailsWith<IllegalArgumentException> { engine.generateText("qwen3-0.6b", "  ", 64, 0.1f) }
        assertFailsWith<IllegalArgumentException> { engine.generateText("qwen3-0.6b", "hi", 0, 0.1f) }
    }

    @Test fun cancelBeforeGenerateThrowsCancelled() {
        val engine = engine(FakeQwenTextHost())
        engine.initialize()
        engine.cancel()
        assertFailsWith<CancellationException> {
            engine.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        }
    }

    @Test fun releaseClearsReadinessAndClosesHost() {
        val host = FakeQwenTextHost()
        val engine = engine(host)
        engine.initialize()
        engine.release()
        assertFalse(engine.isReady)
        assertEquals(1, host.closeCount)
        assertFailsWith<IllegalStateException> {
            engine.generateText("qwen3-0.6b", "hello", 64, 0.1f)
        }
        engine.release()
        assertEquals(1, host.closeCount)
    }

    @Test fun releaseClearsCancelSoNextInitStartsClean() {
        val host = FakeQwenTextHost()
        val engine = engine(host)
        engine.initialize()
        engine.cancel()
        engine.release()
        engine.initialize()
        assertEquals("a useful answer", engine.generateText("qwen3-0.6b", "hello", 64, 0.1f))
    }

    @Test fun selfTestSucceedsOnlyOnUsableOutput() {
        val ready = engine(FakeQwenTextHost(reply = "a useful description"))
        val success = ready.runSelfTest("probe")
        assertTrue(success.success)
        assertNull(success.failure)
        assertTrue(success.diagnostics.isNotEmpty())
        assertTrue(ready.isReady)

        val empty = engine(FakeQwenTextHost(reply = "  "))
        val failed = empty.runSelfTest("probe")
        assertFalse(failed.success)
        assertEquals(SelfTestFailure.GENERATION_ERROR, failed.failure)
    }

    @Test fun selfTestInitFailureIsRuntimeError() {
        val engine = engine(FakeQwenTextHost(initFailure = IllegalStateException("no runtime")))
        val outcome = engine.runSelfTest("probe")
        assertFalse(outcome.success)
        assertEquals(SelfTestFailure.MODEL_RUNTIME_ERROR, outcome.failure)
        assertFalse(engine.isReady)
    }

    @Test fun backendNameReportsConfiguredBackend() {
        val host = FakeQwenTextHost()
        val engine = QwenTextEngine(hostFactory = { host }, diagCacheDir = File("/tmp"), engineBackend = VlmEngineBackend.CPU)
        assertEquals("cpu", engine.backendName)
    }
}
