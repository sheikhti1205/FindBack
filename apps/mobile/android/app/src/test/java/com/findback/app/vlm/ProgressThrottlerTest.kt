package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ProgressThrottlerTest {

    @Test fun firstEmissionAlwaysPasses() {
        val throttler = ProgressThrottler()
        assertTrue(throttler.shouldEmit(0L, 0L))
    }

    @Test fun rapidSmallUpdatesAreThrottled() {
        val throttler = ProgressThrottler(minIntervalMs = 500L, minBytesDelta = 1024L)
        assertTrue(throttler.shouldEmit(0L, 0L))
        assertFalse(throttler.shouldEmit(100L, 100L))
        assertFalse(throttler.shouldEmit(200L, 499L))
    }

    @Test fun timeElapsedForcesEmission() {
        val throttler = ProgressThrottler(minIntervalMs = 500L, minBytesDelta = 1024L)
        assertTrue(throttler.shouldEmit(0L, 0L))
        assertFalse(throttler.shouldEmit(100L, 100L))
        assertTrue(throttler.shouldEmit(100L, 500L))
    }

    @Test fun bytesDeltaForcesEmission() {
        val throttler = ProgressThrottler(minIntervalMs = 60_000L, minBytesDelta = 1024L)
        assertTrue(throttler.shouldEmit(0L, 0L))
        assertTrue(throttler.shouldEmit(2048L, 10L))
    }
}
