package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RuntimeTimingRunnerTest {
    @Test fun invokesRequestedBackendAndUsesActualEngineCounters() {
        val backends = mutableListOf<String>()
        val runner = RuntimeTimingRunner({ File("verified.litertlm") }) { _, backend ->
            backends.add(backend)
            listOf(RuntimeTimingRunner.Sample("red", 0.12, 18.0), RuntimeTimingRunner.Sample("blue", 0.2, 12.0))
        }
        val sample = runner.run("gpu")!!
        assertEquals(listOf("gpu"), backends)
        assertEquals(160.0, sample.ttftMs, 0.001)
        assertEquals(15.0, sample.tokensPerSec, 0.001)
        assertTrue(sample.correctnessPass)
    }
    @Test fun fastWrongBackendProducesFailedCorrectnessEvidence() {
        val runner = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ ->
            listOf(RuntimeTimingRunner.Sample("green", 0.01, 100.0), RuntimeTimingRunner.Sample("blue", 0.01, 100.0))
        }
        assertFalse(runner.run("cpu")!!.correctnessPass)
    }
    @Test fun negatedOrUncertainColorMentionsCannotPassCorrectness() {
        for (answer in listOf("not red", "red or purple", "maybe red", "red red red")) {
            val runner = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ ->
                listOf(RuntimeTimingRunner.Sample(answer, 0.01, 100.0), RuntimeTimingRunner.Sample("blue", 0.01, 100.0))
            }
            assertFalse(runner.run("cpu")!!.correctnessPass, answer)
        }
    }
    @Test fun absentWeightsUnknownBackendAndMissingCountersNeverInventSamples() {
        val absent = RuntimeTimingRunner({ null }) { _, _ -> error("must not invoke") }
        assertNull(absent.run("cpu"))
        val runner = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ ->
            listOf(RuntimeTimingRunner.Sample("red", 0.0, 0.0), RuntimeTimingRunner.Sample("blue", 0.2, 1.0))
        }
        assertNull(runner.run("nnapi"))
        assertNull(runner.run("cpu"))
    }

    @Test fun detailedOutcomeNamesEveryFailureCause() {
        val ok = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ ->
            listOf(RuntimeTimingRunner.Sample("red", 0.12, 18.0), RuntimeTimingRunner.Sample("blue", 0.2, 12.0))
        }
        val success = ok.runDetailed("cpu")
        assertTrue(success is DeviceProbe.BenchmarkOutcome.Success)
        assertTrue((success as DeviceProbe.BenchmarkOutcome.Success).result.correctnessPass)

        val unknown = ok.runDetailed("nnapi")
        assertTrue(unknown is DeviceProbe.BenchmarkOutcome.Failure)
        assertEquals(DeviceProbe.BenchmarkFailure.UNKNOWN_BACKEND, (unknown as DeviceProbe.BenchmarkOutcome.Failure).reason)

        val absent = RuntimeTimingRunner({ null }) { _, _ -> error("must not invoke") }
        val missing = absent.runDetailed("cpu")
        assertTrue(missing is DeviceProbe.BenchmarkOutcome.Failure)
        assertEquals(DeviceProbe.BenchmarkFailure.MODEL_MISSING_OR_UNVERIFIED, (missing as DeviceProbe.BenchmarkOutcome.Failure).reason)

        val crashing = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ -> error("engine exploded") }
        val initFailed = crashing.runDetailed("cpu")
        assertTrue(initFailed is DeviceProbe.BenchmarkOutcome.Failure)
        assertEquals(DeviceProbe.BenchmarkFailure.ENGINE_INIT_FAILED, (initFailed as DeviceProbe.BenchmarkOutcome.Failure).reason)

        val timingOut = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ ->
            kotlinx.coroutines.runBlocking {
                kotlinx.coroutines.withTimeout(1L) { kotlinx.coroutines.delay(1_000L) }
            }
            error("unreachable")
        }
        val timedOut = timingOut.runDetailed("gpu")
        assertTrue(timedOut is DeviceProbe.BenchmarkOutcome.Failure)
        assertEquals(DeviceProbe.BenchmarkFailure.INFERENCE_TIMEOUT, (timedOut as DeviceProbe.BenchmarkOutcome.Failure).reason)

        val empty = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ -> emptyList() }
        val unavailable = empty.runDetailed("cpu")
        assertTrue(unavailable is DeviceProbe.BenchmarkOutcome.Failure)
        assertEquals(DeviceProbe.BenchmarkFailure.COUNTERS_UNAVAILABLE, (unavailable as DeviceProbe.BenchmarkOutcome.Failure).reason)

        val zeroes = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ ->
            listOf(RuntimeTimingRunner.Sample("red", 0.0, 0.0), RuntimeTimingRunner.Sample("blue", 0.2, 1.0))
        }
        val invalid = zeroes.runDetailed("cpu")
        assertTrue(invalid is DeviceProbe.BenchmarkOutcome.Failure)
        assertEquals(DeviceProbe.BenchmarkFailure.COUNTERS_INVALID, (invalid as DeviceProbe.BenchmarkOutcome.Failure).reason)

        // Fast-but-wrong stays Success: selection must see the evidence.
        val wrong = RuntimeTimingRunner({ File("verified.litertlm") }) { _, _ ->
            listOf(RuntimeTimingRunner.Sample("green", 0.01, 100.0), RuntimeTimingRunner.Sample("blue", 0.01, 100.0))
        }
        val wrongOutcome = wrong.runDetailed("cpu")
        assertTrue(wrongOutcome is DeviceProbe.BenchmarkOutcome.Success)
        assertFalse((wrongOutcome as DeviceProbe.BenchmarkOutcome.Success).result.correctnessPass)
    }

    @OptIn(com.google.ai.edge.litertlm.ExperimentalApi::class)
    @Test fun benchmarkFlagIsScopedToMeasurementAndRestored() {
        val flags = com.google.ai.edge.litertlm.ExperimentalFlags
        flags.enableBenchmark = false
        var sawEnabled = false
        val result = RuntimeTimingRunner.withBenchmarkCounters {
            sawEnabled = flags.enableBenchmark
            42
        }
        assertEquals(42, result)
        assertTrue(sawEnabled)
        assertFalse(flags.enableBenchmark)
    }

    @OptIn(com.google.ai.edge.litertlm.ExperimentalApi::class)
    @Test fun benchmarkFlagIsRestoredWhenMeasurementThrows() {
        val flags = com.google.ai.edge.litertlm.ExperimentalFlags
        flags.enableBenchmark = false
        try {
            RuntimeTimingRunner.withBenchmarkCounters { throw IllegalStateException("engine failed") }
        } catch (_: IllegalStateException) {
        }
        assertFalse(flags.enableBenchmark)
    }
}
