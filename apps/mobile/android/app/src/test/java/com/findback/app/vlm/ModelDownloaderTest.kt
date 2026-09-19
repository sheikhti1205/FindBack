package com.findback.app.vlm

import kotlin.math.min
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ModelDownloaderTest {

    @Test
    fun retrySequenceMatchesSpecWithSeededJitter() {
        // Exercises the real policy (not a copied formula): exponential base
        // preserved, seeded jitter deterministic and bounded.
        val jitter = TransferRetryPolicy.seededJitter(7L)
        val delays = (1..5).map { TransferRetryPolicy.backoffMs(it, jitter = jitter) }
        delays.forEachIndexed { i, d ->
            val base = min(1_000L shl i, 30_000L)
            assertTrue(d in base..<base + 250L, "attempt ${i + 1} out of range: $d")
        }
        val again = TransferRetryPolicy.seededJitter(7L)
        assertEquals(delays, (1..5).map { TransferRetryPolicy.backoffMs(it, jitter = again) })
    }
}