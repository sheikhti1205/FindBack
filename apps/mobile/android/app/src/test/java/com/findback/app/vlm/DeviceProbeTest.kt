package com.findback.app.vlm

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * WS-F L2: pure-JVM tests for [DeviceProbe].
 *
 * Contract pins (schema version, backend vocabulary, staleness gate) plus
 * fake-[DeviceProbe.Deps] tests for the collection logic: fact assembly,
 * per-signal fallback strings, failure-to-null mapping, and the
 * timing-runner wiring. No emulator, no device APIs, no I/O — the EGL and
 * JNI paths are covered on-device, not here.
 */
class DeviceProbeTest {

    @BeforeTest fun silenceProbeLogging() {
        DeviceProbe.logWarn = { _, _, _ -> }
    }

    @AfterTest fun restoreProbeLogging() {
        DeviceProbe.logWarn = { tag, message, throwable -> android.util.Log.w(tag, message, throwable) }
    }

    @Test fun probeVersionMatchesTsContract() {
        // Must match TS `PROBE_VERSION` in src/services/ai/deviceProbe.ts.
        assertEquals(1, DeviceProbe.PROBE_VERSION)
    }

    @Test fun backendVocabularyMatchesTsContract() {
        assertEquals("cpu", DeviceProbe.BACKEND_CPU)
        assertEquals("gpu", DeviceProbe.BACKEND_GPU)
        assertEquals("nnapi", DeviceProbe.BACKEND_NNAPI)
    }

    private fun freshRecord() = DeviceProbe.Record(
        socModel = "record-only",
        gpuInfo = "record-only",
        ramMb = 8192L,
        osVersion = "15",
        backend = DeviceProbe.BACKEND_CPU,
        ttftMs = 120.0,
        tokensPerSec = 18.5,
        corpusVersion = "ws6-v1",
        probeVersion = DeviceProbe.PROBE_VERSION,
        modelRev = "smolvlm2-500m-r1",
        correctnessPass = true,
    )

    @Test fun matchingRecordIsNotStale() {
        val record = freshRecord()
        assertFalse(
            DeviceProbe.isStale(
                record = record,
                modelRev = "smolvlm2-500m-r1",
                backend = DeviceProbe.BACKEND_CPU,
                probeVersion = DeviceProbe.PROBE_VERSION,
                corpusVersion = "ws6-v1",
            ),
        )
    }

    @Test fun modelRevisionChangeMakesRecordStale() {
        assertTrue(
            DeviceProbe.isStale(
                record = freshRecord(),
                modelRev = "smolvlm2-500m-r2",
                backend = DeviceProbe.BACKEND_CPU,
                corpusVersion = "ws6-v1",
            ),
        )
    }

    @Test fun backendChangeMakesRecordStale() {
        assertTrue(
            DeviceProbe.isStale(
                record = freshRecord(),
                modelRev = "smolvlm2-500m-r1",
                backend = DeviceProbe.BACKEND_GPU,
                corpusVersion = "ws6-v1",
            ),
        )
    }

    @Test fun probeSchemaChangeMakesRecordStale() {
        assertTrue(
            DeviceProbe.isStale(
                record = freshRecord(),
                modelRev = "smolvlm2-500m-r1",
                backend = DeviceProbe.BACKEND_CPU,
                probeVersion = DeviceProbe.PROBE_VERSION + 1,
                corpusVersion = "ws6-v1",
            ),
        )
    }

    @Test fun corpusVersionChangeMakesRecordStale() {
        assertTrue(
            DeviceProbe.isStale(
                record = freshRecord(),
                modelRev = "smolvlm2-500m-r1",
                backend = DeviceProbe.BACKEND_CPU,
                corpusVersion = "ws6-v2",
            ),
        )
    }

    @Test fun stalenessGateIsAnyMismatchNeverAutoPreferred() {
        // A stale record must be re-measured, never auto-preferred: every
        // single differing dimension flips the gate on its own.
        val record = freshRecord()
        val staleCases = listOf(
            record.copy(modelRev = "other"),
            record.copy(backend = DeviceProbe.BACKEND_NNAPI),
            record.copy(probeVersion = record.probeVersion + 1),
            record.copy(corpusVersion = "ws6-v9"),
        )
        for (stale in staleCases) {
            assertTrue(
                DeviceProbe.isStale(
                    record = stale,
                    modelRev = "smolvlm2-500m-r1",
                    backend = DeviceProbe.BACKEND_CPU,
                    corpusVersion = "ws6-v1",
                ),
                "expected stale: $stale",
            )
        }
    }

    @Test fun recordDefaultsToCurrentProbeVersion() {
        val record = freshRecord().copy(probeVersion = DeviceProbe.PROBE_VERSION)
        assertEquals(DeviceProbe.PROBE_VERSION, record.probeVersion)
    }

    @Test fun collectIsSkeletonAndReturnsNull() {
        // Without a timing runner there is no measured sample: null forces
        // the TS-side `selectBackend` no-probe path (serve cpu, schedule
        // a probe). Identity facts still execute (see collectFacts tests).
        assertNull(
            DeviceProbe.collect(
                backend = DeviceProbe.BACKEND_CPU,
                modelRev = "smolvlm2-500m-r1",
                corpusVersion = "ws6-v1",
                deps = fakeDeps(),
            ),
        )
    }

    private fun fakeDeps(
        ramMb: Long = 8192L,
        socModel: String = "Tensor-test",
        gpu: String = "TestRenderer",
        osVersion: String = "15",
        nnapi: String = "supported:1:t0-TestDriver",
        vulkan: String = "ok:1:v1.3-TestGPU",
        openCl: String = "unavailable",
        timing: DeviceProbe.TimingResult? = null,
        timingThrows: Boolean = false,
    ): DeviceProbe.Deps = object : DeviceProbe.Deps {
        override fun soc() = object : DeviceProbe.SocInfoProvider {
            override fun socModel() = socModel
            override fun osVersion() = osVersion
        }

        override fun ram() = object : DeviceProbe.RamProvider {
            override fun totalRamMb() = ramMb
        }

        override fun gpu() = object : DeviceProbe.GpuInfoProvider {
            override fun rendererSummary() = gpu
        }

        override fun nnapi() = object : DeviceProbe.NnapiProbe {
            override fun status() = nnapi
        }

        override fun vulkan() = object : DeviceProbe.VulkanProbe {
            override fun status() = vulkan
        }

        override fun openCl() = object : DeviceProbe.OpenClProbe {
            override fun status() = openCl
        }

        override fun timing(): DeviceProbe.TimingRunner? =
            if (timing == null && !timingThrows) null
            else object : DeviceProbe.TimingRunner {
                override fun run(backend: String): DeviceProbe.TimingResult? {
                    if (timingThrows) throw IllegalStateException("no runtime")
                    return timing
                }
            }
    }

    @Test fun collectFactsReturnsRealEvidence() {
        val facts = DeviceProbe.collectFacts(fakeDeps())
        assertNotNull(facts)
        assertEquals("Tensor-test", facts.socModel)
        assertEquals(8192L, facts.ramMb)
        assertEquals("supported:1:t0-TestDriver", facts.nnapiStatus)
        assertEquals("ok:1:v1.3-TestGPU", facts.vulkanStatus)
        assertEquals("unavailable", facts.openClStatus)
    }

    @Test fun collectFactsDegradesPerSignalToFallbacks() {
        val facts = DeviceProbe.collectFacts(
            fakeDeps(socModel = "", gpu = "", nnapi = "", vulkan = "", openCl = ""),
        )
        assertNotNull(facts)
        assertEquals("unknown", facts.socModel)
        assertEquals("unknown", facts.gpuInfo)
        assertEquals("unavailable-unknown", facts.nnapiStatus)
    }

    @Test fun collectFactsNullWhenRamUnreadable() {
        assertNull(DeviceProbe.collectFacts(fakeDeps(ramMb = 0L)))
        assertNull(DeviceProbe.collectFacts(fakeDeps(ramMb = -1L)))
    }

    @Test fun collectFactsReportsSupportedAbisFailClosedWhenUnreadable() {
        val facts = DeviceProbe.collectFacts(fakeDeps())
        assertNotNull(facts)
        // Plain JVM unit tests stub android.os.Build, so SUPPORTED_ABIS is
        // unreadable here: facts must carry an empty (never null, never
        // compatible-by-default) ABI list. On device the same field carries
        // Build.SUPPORTED_ABIS for the download gate.
        assertEquals(emptyList<String>(), facts.supportedAbis)
    }

    @Test fun collectReturnsNullOnBlankArguments() {
        val deps = fakeDeps(timing = DeviceProbe.TimingResult(10.0, 20.0, true))
        assertNull(DeviceProbe.collect("", "r1", "c1", deps))
        assertNull(DeviceProbe.collect("cpu", "", "c1", deps))
        assertNull(DeviceProbe.collect("cpu", "r1", "", deps))
    }

    @Test fun collectReturnsRecordWhenRunnerMeasures() {
        val record = DeviceProbe.collect(
            backend = DeviceProbe.BACKEND_GPU,
            modelRev = "smolvlm2-500m-r1",
            corpusVersion = "ws6-v1",
            deps = fakeDeps(timing = DeviceProbe.TimingResult(120.0, 18.5, true)),
        )
        assertNotNull(record)
        assertEquals(DeviceProbe.BACKEND_GPU, record.backend)
        assertEquals(120.0, record.ttftMs)
        assertEquals(18.5, record.tokensPerSec)
        assertTrue(record.correctnessPass)
        assertTrue(record.gpuInfo.contains("nnapi=supported:1:t0-TestDriver"))
    }

    @Test fun collectKeepsFailingSamplesVisible() {
        // A fast-but-wrong backend must never win by hiding: correctness
        // false still returns a record; selection filters it.
        val record = DeviceProbe.collect(
            backend = DeviceProbe.BACKEND_CPU,
            modelRev = "r1",
            corpusVersion = "c1",
            deps = fakeDeps(timing = DeviceProbe.TimingResult(5.0, 99.0, false)),
        )
        assertNotNull(record)
        assertFalse(record.correctnessPass)
    }

    @Test fun collectReturnsNullWhenRunnerThrows() {
        assertNull(
            DeviceProbe.collect(
                backend = DeviceProbe.BACKEND_CPU,
                modelRev = "r1",
                corpusVersion = "c1",
                deps = fakeDeps(timingThrows = true),
            ),
        )
    }
}
