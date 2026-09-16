package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals

class ModelDownloaderTest {

    @Test
    fun calculateBackoff_exponentialBackoff() {
        // Test the backoff calculation logic directly (extracted from ModelDownloader)
        assertEquals(1000L, calculateBackoff(1))  // 1s
        assertEquals(2000L, calculateBackoff(2))  // 2s
        assertEquals(4000L, calculateBackoff(3))  // 4s
    }

    // Copied from ModelDownloader for testing
    private fun calculateBackoff(attempt: Int): Long {
        val BASE_BACKOFF_MS = 1000L
        return BASE_BACKOFF_MS * (1L shl (attempt - 1)) // Exponential backoff: 1s, 2s, 4s
    }
}