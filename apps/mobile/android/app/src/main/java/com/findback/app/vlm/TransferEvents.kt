package com.findback.app.vlm

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * Transfer event emitted by whichever scheduler backend runs the shared
 * chunk engine (UIDT JobService on API 34+, WorkManager below).
 * Same-process bridge so the Capacitor plugin can forward truthful
 * state + true MB/MB progress to JS listeners.
 */
data class TransferEvent(
    val modelId: VlmModelId,
    val state: VlmState,
    val downloadedBytes: Long = 0L,
    val totalBytes: Long = 0L,
    val error: String? = null
)

object TransferEvents {
    private val _events = MutableSharedFlow<TransferEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<TransferEvent> = _events.asSharedFlow()

    fun emit(event: TransferEvent) {
        _events.tryEmit(event)
    }
}
