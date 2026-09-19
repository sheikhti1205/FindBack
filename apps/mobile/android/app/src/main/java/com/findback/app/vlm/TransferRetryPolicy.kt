package com.findback.app.vlm

import kotlin.math.min
import kotlin.random.Random

/**
 * Retry semantics for chunk transfers (spec section 8).
 *
 * Transient (bounded exponential backoff + jitter + Retry-After, verified
 * chunks never reset): timeout, transient DNS, 408 / 425 / 429 / 5xx.
 * Permanent/actionable: unexpected 401/403, pinned 404, invalid
 * Content-Range, missing immutable source, manifest mismatch.
 * After the retry budget: PAUSED_ERROR with partials preserved + UI Resume.
 */
object TransferRetryPolicy {
    const val BASE_BACKOFF_MS: Long = 1_000L
    const val MAX_BACKOFF_MS: Long = 30_000L
    const val MAX_ATTEMPTS: Int = 5

    private val RETRYABLE_CODES: Set<Int> = setOf(408, 425, 429, 500, 502, 503, 504)

    /**
     * Whether an HTTP status is transient and worth retrying.
     */
    fun isRetryable(httpCode: Int): Boolean = httpCode in RETRYABLE_CODES

    /**
     * Bounded exponential backoff: BASE * 2^(attempt-1) capped at
     * [MAX_BACKOFF_MS], plus caller-supplied jitter. When [retryAfterMs] is
     * provided (parsed from Retry-After), it wins if larger than the computed
     * backoff so server guidance is honored.
     */
    fun backoffMs(
        attempt: Int,
        retryAfterMs: Long? = null,
        jitter: () -> Long = { Random.nextLong(0L, 250L) }
    ): Long {
        require(attempt >= 1) { "attempt must be >= 1" }
        val shift = min(attempt - 1, 20)
        val exponential = BASE_BACKOFF_MS shl shift
        val capped = min(exponential, MAX_BACKOFF_MS)
        val withJitter = capped + jitter()
        return if (retryAfterMs != null) maxOf(withJitter, retryAfterMs) else withJitter
    }

    /**
     * Parses a Retry-After value: delta-seconds (numeric) -> millis.
     * HTTP-date form is not parsed here; returns null for unknown values.
     */
    fun parseRetryAfter(value: String?): Long? {
        if (value == null) return null
        val seconds = value.trim().toLongOrNull() ?: return null
        if (seconds < 0) return null
        return seconds * 1_000L
    }

    /**
     * Deterministic jitter source (audit #38): the same seed yields the same
     * sequence, so retry timing is reproducible in tests. Production passes
     * the default unseeded Random via [backoffMs].
     */
    fun seededJitter(seed: Long): () -> Long {
        val rng = Random(seed)
        return { rng.nextLong(0L, 250L) }
    }

    /**
     * Whether the retry budget is exhausted (-> PAUSED_ERROR, keep partials).
     */
    fun budgetExhausted(attempt: Int, maxAttempts: Int = MAX_ATTEMPTS): Boolean {
        return attempt > maxAttempts
    }
}
