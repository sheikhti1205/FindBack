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
}
