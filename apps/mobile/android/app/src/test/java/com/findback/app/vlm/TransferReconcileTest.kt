package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class TransferReconcileTest {

    @Test fun transientWithoutLiveJobBecomesPaused() {
        for (state in TransferReconcile.TRANSIENT_STATES) {
            assertEquals(
                VlmState.PAUSED,
                TransferReconcile.reconcileState(state, hasLiveJob = false),
                "transient $state with no live job must reconcile to PAUSED"
            )
        }
    }

    @Test fun transientWithLiveJobIsKept() {
        assertEquals(
            VlmState.DOWNLOADING,
            TransferReconcile.reconcileState(VlmState.DOWNLOADING, hasLiveJob = true)
        )
        assertEquals(
            VlmState.QUEUED,
            TransferReconcile.reconcileState(VlmState.QUEUED, hasLiveJob = true)
        )
    }

    @Test fun terminalAndUserStatesPassThrough() {
        val passthrough = listOf(
            VlmState.NOT_INSTALLED,
            VlmState.PAUSED,
            VlmState.PAUSED_ERROR,
            VlmState.INSTALLED_UNVERIFIED,
            VlmState.READY_GPU,
            VlmState.MANIFEST_MISMATCH,
            VlmState.CORRUPT,
            VlmState.INSUFFICIENT_STORAGE,
            VlmState.DOWNLOAD_FAILED
        )
        for (state in passthrough) {
            assertEquals(state, TransferReconcile.reconcileState(state, hasLiveJob = false))
            assertFalse(TransferReconcile.needsReconcile(state, hasLiveJob = false))
        }
        assertTrue(TransferReconcile.needsReconcile(VlmState.DOWNLOADING, hasLiveJob = false))
    }
}
