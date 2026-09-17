package com.findback.app.vlm

/**
 * Throttles per-chunk progress callbacks into bounded WorkManager
 * `setProgress`/foreground-notification updates. First emission always
 * passes; later ones pass when enough time elapsed or enough bytes arrived.
 * Pure JVM logic so the throttle is unit-testable.
 */
class ProgressThrottler(
    private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
    private val minBytesDelta: Long = DEFAULT_MIN_BYTES_DELTA
) {
    companion object {
        const val DEFAULT_MIN_INTERVAL_MS: Long = 500L
        const val DEFAULT_MIN_BYTES_DELTA: Long = 256L * 1024L
    }

    private var lastEmitMs: Long? = null
    private var lastBytes: Long = 0L

    @Synchronized
    fun shouldEmit(downloadedBytes: Long, nowMs: Long): Boolean {
        val lastMs = lastEmitMs
        if (lastMs == null || downloadedBytes < lastBytes) {
            lastEmitMs = nowMs
            lastBytes = downloadedBytes
            return true
        }
        if (nowMs - lastMs >= minIntervalMs || downloadedBytes - lastBytes >= minBytesDelta) {
            lastEmitMs = nowMs
            lastBytes = downloadedBytes
            return true
        }
        return false
    }

    @Synchronized
    fun reset() {
        lastEmitMs = null
        lastBytes = 0L
    }
}
