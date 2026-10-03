package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * WS-F L2: pure-JVM pinning tests for [LiteRtBackend].
 *
 * Covers the stable-path invariants WITHOUT any LiteRT runtime (no emulator,
 * no delegates, no model assets):
 * - CPU-first: both residents default to CPU.
 * - GPU only with a fresh pass record for THAT resident; vision evidence
 *   never unlocks language GPU and vice versa.
 * - Missing, failed, expired, or future-dated evidence resolves back to CPU.
 * - Never cloud: there is no cloud member on the backend enum.
 */
class LiteRtBackendTest {

    @Test fun stableDefaultIsCpuCpu() {
        assertEquals(
            VisionLanguageSplit(
                visionBackend = LiteRtComputeBackend.CPU,
                languageBackend = LiteRtComputeBackend.CPU,
            ),
            VisionLanguageSplit.STABLE_DEFAULT,
        )
    }

    @Test fun backendEnumHasNoCloudMember() {
        // The never-cloud invariant is structural: an unavailable vision path
        // cannot silently fall back to a hosted provider.
        assertEquals(
            setOf(LiteRtComputeBackend.CPU, LiteRtComputeBackend.GPU),
            LiteRtComputeBackend.values().toSet(),
        )
    }

    @Test fun cpuRequestAlwaysResolvesCpu() {
        assertEquals(
            LiteRtComputeBackend.CPU,
            LiteRtBackend.resolve(LiteRtComputeBackend.CPU, evidence = null),
        )
        assertEquals(
            LiteRtComputeBackend.CPU,
            LiteRtBackend.resolve(
                LiteRtComputeBackend.CPU,
                evidence = GpuProbePassRecord(passed = true, measuredAtMs = System.currentTimeMillis()),
            ),
        )
    }

    @Test fun gpuRequestWithoutEvidenceResolvesCpu() {
        assertEquals(
            LiteRtComputeBackend.CPU,
            LiteRtBackend.resolve(LiteRtComputeBackend.GPU, evidence = null),
        )
    }

    @Test fun gpuRequestWithFreshEvidenceResolvesGpu() {
        val now = System.currentTimeMillis()
        val evidence = GpuProbePassRecord(passed = true, measuredAtMs = now - 1_000L)
        assertTrue(evidence.isFresh(nowMs = now))
        assertEquals(LiteRtComputeBackend.GPU, LiteRtBackend.resolve(LiteRtComputeBackend.GPU, evidence))
    }

    @Test fun failedProbeHasNoRepresentationAndResolvesCpu() {
        val now = System.currentTimeMillis()
        val evidence = GpuProbePassRecord(passed = false, measuredAtMs = now - 1_000L)
        assertFalse(evidence.isFresh(nowMs = now))
        assertEquals(LiteRtComputeBackend.CPU, LiteRtBackend.resolve(LiteRtComputeBackend.GPU, evidence))
    }

    @Test fun expiredProbeResolvesCpu() {
        val now = System.currentTimeMillis()
        val evidence = GpuProbePassRecord(
            passed = true,
            measuredAtMs = now - GPU_PROBE_PASS_TTL_MS - 1L,
        )
        assertFalse(evidence.isFresh(nowMs = now))
        assertEquals(LiteRtComputeBackend.CPU, LiteRtBackend.resolve(LiteRtComputeBackend.GPU, evidence))
    }

    @Test fun futureDatedProbeResolvesCpu() {
        val now = System.currentTimeMillis()
        val evidence = GpuProbePassRecord(passed = true, measuredAtMs = now + 60_000L)
        assertFalse(evidence.isFresh(nowMs = now))
        assertEquals(LiteRtComputeBackend.CPU, LiteRtBackend.resolve(LiteRtComputeBackend.GPU, evidence))
    }

    @Test fun freshnessWindowIs24Hours() {
        assertEquals(24L * 60 * 60 * 1000, GPU_PROBE_PASS_TTL_MS)
        val now = System.currentTimeMillis()
        assertTrue(GpuProbePassRecord(passed = true, measuredAtMs = now - GPU_PROBE_PASS_TTL_MS).isFresh(nowMs = now))
        assertFalse(
            GpuProbePassRecord(passed = true, measuredAtMs = now - GPU_PROBE_PASS_TTL_MS - 1L).isFresh(nowMs = now),
        )
    }

    @Test fun degenerateRecordsAreNeverFresh() {
        val now = System.currentTimeMillis()
        assertFalse(GpuProbePassRecord(passed = true, measuredAtMs = 0L).isFresh(nowMs = now))
        assertFalse(GpuProbePassRecord(passed = true, measuredAtMs = -1L).isFresh(nowMs = now))
        assertFalse(
            GpuProbePassRecord(passed = true, measuredAtMs = now - 1_000L, ttlMs = -1L).isFresh(nowMs = now),
        )
    }

    @Test fun splitResolutionIsIndependentPerResident() {
        val now = System.currentTimeMillis()
        val fresh = GpuProbePassRecord(passed = true, measuredAtMs = now - 1_000L)

        // A vision pass never unlocks language GPU (or vice versa).
        assertEquals(
            VisionLanguageSplit(
                visionBackend = LiteRtComputeBackend.GPU,
                languageBackend = LiteRtComputeBackend.CPU,
            ),
            LiteRtBackend.resolveSplit(
                requested = VisionLanguageSplit(
                    visionBackend = LiteRtComputeBackend.GPU,
                    languageBackend = LiteRtComputeBackend.GPU,
                ),
                visionEvidence = fresh,
                languageEvidence = null,
            ),
        )
        assertEquals(
            VisionLanguageSplit(
                visionBackend = LiteRtComputeBackend.CPU,
                languageBackend = LiteRtComputeBackend.GPU,
            ),
            LiteRtBackend.resolveSplit(
                requested = VisionLanguageSplit(
                    visionBackend = LiteRtComputeBackend.GPU,
                    languageBackend = LiteRtComputeBackend.GPU,
                ),
                visionEvidence = null,
                languageEvidence = fresh,
            ),
        )
    }

    @Test fun splitCpuCpuNeedsNoEvidence() {
        assertEquals(
            VisionLanguageSplit.STABLE_DEFAULT,
            LiteRtBackend.resolveSplit(
                requested = VisionLanguageSplit.STABLE_DEFAULT,
                visionEvidence = null,
                languageEvidence = null,
            ),
        )
    }
}
