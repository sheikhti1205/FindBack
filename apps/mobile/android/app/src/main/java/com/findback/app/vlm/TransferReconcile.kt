package com.findback.app.vlm

/**
 * Reconciles persisted transfer states on plugin load (spec section 9).
 *
 * A persisted transient state (QUEUED, DOWNLOADING, PAUSING, VERIFYING_xxx,
 * REPAIRING) with no live job means the process died or the scheduler
 * dropped the work: report PAUSED so the UI offers resume. Verified chunks and the journal are
 * untouched, so resume continues missing ranges only. All other states pass
 * through, including user PAUSED and terminal states.
 */
object TransferReconcile {

    val TRANSIENT_STATES: Set<VlmState> = setOf(
        VlmState.QUEUED,
        VlmState.DOWNLOADING,
        VlmState.PAUSING,
        VlmState.VERIFYING_CHUNK,
        VlmState.VERIFYING_HASH,
        VlmState.VERIFYING_FILE,
        VlmState.REPAIRING
    )

    fun reconcileState(persisted: VlmState, hasLiveJob: Boolean): VlmState {
        if (!hasLiveJob && persisted in TRANSIENT_STATES) return VlmState.PAUSED
        return persisted
    }

    fun needsReconcile(persisted: VlmState, hasLiveJob: Boolean): Boolean {
        return reconcileState(persisted, hasLiveJob) != persisted
    }
}
