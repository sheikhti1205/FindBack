package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class WarmEngineLeaseTest {

    @Test fun acquireAndRefreshKeepsSingleEngineResident() {
        val clock = FakeClock(0L)
        val lease = WarmEngineLease(clock)
        lease.acquire(VlmModelId.SMOLVLM2_500M)
        clock.advance(30_000L)
        lease.refresh() // inference refreshes lease
        clock.advance(30_000L)
        assertTrue(lease.isResident(), "lease refreshed at 30s should still be resident at 60s")
        assertEquals(VlmModelId.SMOLVLM2_500M, lease.residentModel())
    }

    @Test fun idleTtlExpiresAfter60s() {
        val clock = FakeClock(0L)
        val lease = WarmEngineLease(clock)
        lease.acquire(VlmModelId.SMOLVLM2_500M)
        clock.advance(61_000L)
        assertTrue(lease.isExpired())
        lease.releaseIfExpired { /* engine release callback */ true }
        assertFalse(lease.isResident())
    }

    @Test fun modelSwitchReleasesOldEngine() {
        val clock = FakeClock(0L)
        val lease = WarmEngineLease(clock)
        lease.acquire(VlmModelId.SMOLVLM2_500M)
        var released: VlmModelId? = null
        lease.acquire(VlmModelId.SMOLVLM_256M) { released = it }
        assertEquals(VlmModelId.SMOLVLM2_500M, released)
        assertEquals(VlmModelId.SMOLVLM_256M, lease.residentModel())
    }

    @Test fun timeUntilExpiryCountsDownForHandlerSchedule() {
        val clock = FakeClock(0L)
        val lease = WarmEngineLease(clock)
        assertEquals(0L, lease.timeUntilExpiryMs())
        lease.acquire(VlmModelId.SMOLVLM2_500M)
        assertEquals(60_000L, lease.timeUntilExpiryMs())
        clock.advance(10_000L)
        assertEquals(50_000L, lease.timeUntilExpiryMs())
        lease.refresh()
        assertEquals(60_000L, lease.timeUntilExpiryMs())
    }

    @Test fun takeExpiredResidentClearsInOneStep() {
        val clock = FakeClock(0L)
        val lease = WarmEngineLease(clock)
        assertNull(lease.takeExpiredResident())
        lease.acquire(VlmModelId.SMOLVLM2_500M)
        assertNull(lease.takeExpiredResident())
        assertTrue(lease.isResident())
        clock.advance(61_000L)
        assertEquals(VlmModelId.SMOLVLM2_500M, lease.takeExpiredResident())
        assertFalse(lease.isResident())
        assertEquals(0L, lease.timeUntilExpiryMs())
        assertEquals(0L, lease.deadlineMs())
    }

    @Test fun deadlineMatchesAcquirePlusTtl() {
        val clock = FakeClock(5_000L)
        val lease = WarmEngineLease(clock)
        lease.acquire(VlmModelId.SMOLVLM_256M)
        assertEquals(65_000L, lease.deadlineMs())
    }

    @Test fun memoryTrimReleasesImmediately() {
        val clock = FakeClock(0L)
        val lease = WarmEngineLease(clock)
        lease.acquire(VlmModelId.SMOLVLM2_500M)
        lease.releaseNow()
        assertFalse(lease.isResident())
        assertNull(lease.residentModel())
    }

    @Test fun neverTwoEnginesResident() {
        val clock = FakeClock(0L)
        val lease = WarmEngineLease(clock)
        lease.acquire(VlmModelId.SMOLVLM2_500M)
        lease.acquire(VlmModelId.SMOLVLM_256M)
        // Only the latest model may be resident.
        assertEquals(VlmModelId.SMOLVLM_256M, lease.residentModel())
    }
}
