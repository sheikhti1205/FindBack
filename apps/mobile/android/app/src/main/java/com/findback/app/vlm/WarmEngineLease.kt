package com.findback.app.vlm

/**
 * Single-resident warm engine lease (spec section 15).
 *
 * Keeps one VLM engine loaded while the active report AI flow continues:
 * each inference refreshes the lease, idle TTL is ~60s, leaving the AI flow
 * may release sooner, a model switch releases the old engine, memory trim /
 * model delete / sustained background release immediately. Both big VLM
 * engines are never resident together.
 */
class WarmEngineLease(
    private val clock: Clock,
    private val idleTtlMs: Long = DEFAULT_IDLE_TTL_MS
) {
    interface Clock {
        fun nowMs(): Long
    }

    companion object {
        const val DEFAULT_IDLE_TTL_MS: Long = 60_000L
    }

    private var resident: VlmModelId? = null
    private var leaseExpiresAtMs: Long = 0L

    /**
     * Acquires the lease for [model]. Switching models releases the previous
     * engine first via [onReleased]; re-acquiring the same model refreshes it.
     */
    @Synchronized
    fun acquire(model: VlmModelId, onReleased: (VlmModelId) -> Unit = {}) {
        val previous = resident
        if (previous != null && previous != model) {
            resident = null
            onReleased(previous)
        }
        resident = model
        leaseExpiresAtMs = clock.nowMs() + idleTtlMs
    }

    /**
     * Refreshes the lease (call on each inference while the AI flow is active).
     */
    @Synchronized
    fun refresh() {
        if (resident != null) {
            leaseExpiresAtMs = clock.nowMs() + idleTtlMs
        }
    }

    @Synchronized
    fun isResident(): Boolean = resident != null

    @Synchronized
    fun residentModel(): VlmModelId? = resident

    @Synchronized
    fun isExpired(): Boolean {
        if (resident == null) return false
        return clock.nowMs() >= leaseExpiresAtMs
    }

    /**
     * Milliseconds until the lease expires. Returns 0 when no engine is
     * resident or the TTL already elapsed. The plugin uses this to schedule
     * a Handler postDelayed reclaim instead of polling with a timer.
     */
    @Synchronized
    fun timeUntilExpiryMs(): Long {
        if (resident == null) return 0L
        return (leaseExpiresAtMs - clock.nowMs()).coerceAtLeast(0L)
    }

    /**
     * Absolute deadline (same clock as [Clock.nowMs]) or 0 when no lease.
     */
    @Synchronized
    fun deadlineMs(): Long = if (resident == null) 0L else leaseExpiresAtMs

    /**
     * Returns the resident model when the TTL expired and clears the lease
     * in one step, or null when resident-and-fresh or empty. The caller
     * performs the actual engine release for the returned model.
     */
    @Synchronized
    fun takeExpiredResident(): VlmModelId? {
        if (!isExpired()) return null
        val expired = resident
        resident = null
        return expired
    }

    /**
     * Releases the engine if the TTL expired. [releaseEngine] performs the
     * actual release and returns true on success.
     */
    @Synchronized
    fun releaseIfExpired(releaseEngine: () -> Boolean): Boolean {
        if (!isExpired()) return false
        if (releaseEngine()) {
            resident = null
            return true
        }
        return false
    }

    /**
     * Immediate release (memory trim, model delete, leaving AI flow).
     */
    @Synchronized
    fun releaseNow() {
        resident = null
    }
}
