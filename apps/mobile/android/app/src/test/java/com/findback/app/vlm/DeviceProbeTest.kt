package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * WS-F L2: pure-JVM pinning tests for [DeviceProbe].
 *
 * Tests the probe-record contract only (schema version, backend vocabulary,
 * staleness gate, skeleton-collect nullability). Collection itself is NOT YET
 * IMPLEMENTED on the native side and stays untested here by design — no
 * emulator, no device APIs, no I/O.
 */
class DeviceProbeTest {

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
        // Native measurement is not implemented yet; null forces the TS-side
        // `selectBackend` no-probe path (serve cpu, schedule a probe).
        assertNull(
            DeviceProbe.collect(
                backend = DeviceProbe.BACKEND_CPU,
                modelRev = "smolvlm2-500m-r1",
                corpusVersion = "ws6-v1",
            ),
        )
    }
}
