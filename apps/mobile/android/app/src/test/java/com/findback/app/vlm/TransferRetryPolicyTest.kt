package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TransferRetryPolicyTest {

    @Test fun retryableCodes() {
        for (code in listOf(408, 425, 429, 500, 502, 503, 504)) {
            assertTrue(TransferRetryPolicy.isRetryable(code), "expected retryable: $code")
        }
    }

    @Test fun permanentCodes() {
        for (code in listOf(401, 403, 404)) {
            assertFalse(TransferRetryPolicy.isRetryable(code), "expected permanent: $code")
        }
    }

    @Test fun backoffBoundedWithJitter() {
        val d1 = TransferRetryPolicy.backoffMs(attempt = 1, jitter = { 50L })
        val d2 = TransferRetryPolicy.backoffMs(attempt = 2, jitter = { 50L })
        val d3 = TransferRetryPolicy.backoffMs(attempt = 10, jitter = { 0L })
        assertEquals(1000L + 50L, d1)
        assertEquals(2000L + 50L, d2)
        assertEquals(TransferRetryPolicy.MAX_BACKOFF_MS, d3)
    }

    @Test fun retryAfterOverridesWhenLarger() {
        val d = TransferRetryPolicy.backoffMs(attempt = 1, retryAfterMs = 30_000L, jitter = { 0L })
        assertEquals(30_000L, d)
    }

    @Test fun parsesRetryAfterSeconds() {
        assertEquals(5_000L, TransferRetryPolicy.parseRetryAfter("5"))
    }

    @Test fun parsesRetryAfterUnknownAsNull() {
        assertEquals(null, TransferRetryPolicy.parseRetryAfter("not-a-date"))
    }

    @Test fun retryBudgetExhaustedGoesPausedError() {
        assertTrue(TransferRetryPolicy.budgetExhausted(attempt = 6, maxAttempts = 5))
        assertFalse(TransferRetryPolicy.budgetExhausted(attempt = 5, maxAttempts = 5))
    }
}
