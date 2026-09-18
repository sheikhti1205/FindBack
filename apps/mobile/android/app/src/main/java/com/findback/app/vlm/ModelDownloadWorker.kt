package com.findback.app.vlm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException

/**
 * Foreground-capable WorkManager fallback for API 24-33 running the same
 * chunk transfer engine as the API 34+ UIDT job. Shows a foreground
 * notification with model, true MB/MB, percentage, and state. No fake ETA.
 */
class ModelDownloadWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val modelWire = inputData.getString(ModelDownloadScheduler.EXTRA_MODEL_ID)
        val modelId = modelWire?.let { VlmModelId.fromWire(it) } ?: return Result.failure()
        val manifest = MODEL_MANIFESTS.singleOrNull { it.id == modelId.wire } ?: return Result.failure()
        val totalBytes = manifest.files.sumOf { it.expectedBytes }
        val store = ModelStore.create(applicationContext)
        val engine = ModelDownloader(applicationContext, store)

        setForeground(makeForegroundInfo(modelId, "Starting…", 0L, totalBytes))
        if (TransferControls.isUserPaused(applicationContext, modelId)) {
            TransferEvents.emit(TransferEvent(modelId, VlmState.PAUSED, 0L, totalBytes))
            store.saveTransferRecord(manifest, VlmState.PAUSED)
            return Result.success()
        }
        TransferEvents.emit(TransferEvent(modelId, VlmState.QUEUED, 0L, totalBytes))
        store.saveTransferRecord(manifest, VlmState.QUEUED)

        return try {
            val throttler = ProgressThrottler()
            val finalState = engine.download(
                manifest = manifest,
                onProgress = { downloaded, total ->
                    // Throttled: chunk callbacks are far more frequent than
                    // useful updates. Both the app event bus and the system
                    // foreground notification move together so they never
                    // disagree ("Starting…" while the screen shows 40%).
                    if (throttler.shouldEmit(downloaded, System.currentTimeMillis())) {
                        TransferEvents.emit(TransferEvent(modelId, VlmState.DOWNLOADING, downloaded, total))
                        updateForegroundNotification(modelId, downloaded, total)
                    }
                },
                onState = { transferState ->
                    TransferEvents.emit(TransferEvent(modelId, transferState))
                    store.saveTransferRecord(manifest, transferState)
                }
            )
            TransferEvents.emit(TransferEvent(modelId, finalState))
            store.saveTransferRecord(manifest, finalState)
            showTerminalNotification(modelId, finalState, totalBytes)
            // The state machine owns the outcome. WorkManager retry is only
            // for a transfer that is somehow still in progress; every settled
            // state (installed, paused, failed, corrupt) stops here and waits
            // for the user, otherwise a retry loop fights the pause UI.
            if (finalState in TransferReconcile.TRANSIENT_STATES) {
                Result.retry()
            } else {
                Result.success()
            }
        } catch (e: CancellationException) {
            // System stop / explicit cancel: not a failure. Verified chunks
            // and the journal are preserved; report PAUSED so resume works.
            TransferEvents.emit(TransferEvent(modelId, VlmState.PAUSED, 0L, totalBytes))
            store.saveTransferRecord(manifest, VlmState.PAUSED)
            showTerminalNotification(modelId, VlmState.PAUSED, totalBytes)
            Result.success()
        } catch (e: Exception) {
            // The engine already exhausted its own retry budget before
            // throwing, so this is PAUSED_ERROR awaiting user Resume — not an
            // automatic WorkManager retry that would fight the pause.
            TransferEvents.emit(TransferEvent(modelId, VlmState.PAUSED_ERROR, error = e.message))
            store.saveTransferRecord(manifest, VlmState.PAUSED_ERROR, e.message)
            Result.success()
        }
    }

    /** Refresh the ongoing foreground notification with true bytes/percent. */
    private fun updateForegroundNotification(modelId: VlmModelId, downloaded: Long, total: Long) {
        val nm = applicationContext.getSystemService(NotificationManager::class.java) ?: return
        nm.notify(NOTIFICATION_ID, makeForegroundInfo(modelId, "", downloaded, total).notification)
    }

    private fun makeForegroundInfo(
        modelId: VlmModelId,
        text: String,
        downloaded: Long,
        total: Long
    ): ForegroundInfo {
        ensureChannel()
        val progress = if (total > 0) (downloaded * 100 / total).toInt().coerceIn(0, 100) else 0
        val notification: Notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setContentTitle("Downloading ${modelId.wire}")
            .setContentText(text.ifEmpty { "$progress%" })
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setProgress(100, progress, total <= 0)
            .setOngoing(true)
            .build()
        return if (Build.VERSION.SDK_INT >= 29) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = applicationContext.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Model downloads", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    /**
     * Terminal notification: dismissible (`ongoing = false`), never left as
     * an ongoing foreground-style entry.
     */
    private fun showTerminalNotification(modelId: VlmModelId, state: VlmState, totalBytes: Long) {
        if (Build.VERSION.SDK_INT < 26) return
        ensureChannel()
        val text = when (state) {
            VlmState.INSTALLED_UNVERIFIED -> "Download complete — integrity verified"
            VlmState.PAUSED, VlmState.PAUSED_ERROR -> "Download paused"
            VlmState.INSUFFICIENT_STORAGE -> "Download paused — storage full"
            VlmState.MANIFEST_MISMATCH -> "Download stopped — source mismatch"
            else -> "Download ${state.wire.lowercase().replace('_', ' ')}"
        }
        val progress = if (state == VlmState.INSTALLED_UNVERIFIED) 100 else 0
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setContentTitle("Downloading ${modelId.wire}")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setProgress(100, progress, totalBytes <= 0)
            .setOngoing(false)
            .setAutoCancel(true)
            .build()
        applicationContext.getSystemService(NotificationManager::class.java)
            ?.notify(NOTIFICATION_ID, notification)
    }

    companion object {
        const val CHANNEL_ID = "findback_model_download"
        const val NOTIFICATION_ID = 4201
    }
}
