package com.findback.app.vlm

import kotlin.math.min
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
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

    private fun distribution(state: DistributionState) = ModelDistribution(
        repo = "sheikhti1205/FindBack-Models",
        tag = "models-2026-09-22-v1",
        asset = "test.fbmodel",
        bytes = 64L,
        sha256 = "ab".repeat(32),
        state = state
    )

    @Test
    fun downloadRefusedWithoutDistributionPin() {
        assertFalse(ModelDownloader.isDownloadPermitted(null))
    }

    @Test
    fun downloadRefusedWhileUnpublished() {
        assertFalse(ModelDownloader.isDownloadPermitted(distribution(DistributionState.UNPUBLISHED)))
    }

    @Test
    fun downloadPermittedOncePublished() {
        assertTrue(ModelDownloader.isDownloadPermitted(distribution(DistributionState.PUBLISHED)))
    }
}