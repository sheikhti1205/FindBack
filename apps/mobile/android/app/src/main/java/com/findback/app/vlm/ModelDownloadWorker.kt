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
            val finalState = engine.download(
                manifest = manifest,
                onProgress = { downloaded, total ->
                    TransferEvents.emit(TransferEvent(modelId, VlmState.DOWNLOADING, downloaded, total))
                },
                onState = { transferState ->
                    TransferEvents.emit(TransferEvent(modelId, transferState))
                    store.saveTransferRecord(manifest, transferState)
                }
            )
            TransferEvents.emit(TransferEvent(modelId, finalState))
            store.saveTransferRecord(manifest, finalState)
            if (finalState == VlmState.INSTALLED_UNVERIFIED ||
                finalState == VlmState.PAUSED ||
                finalState == VlmState.PAUSED_ERROR ||
                finalState == VlmState.INSUFFICIENT_STORAGE ||
                finalState == VlmState.MANIFEST_MISMATCH
            ) {
                Result.success()
            } else {
                Result.retry()
            }
        } catch (e: Exception) {
            TransferEvents.emit(TransferEvent(modelId, VlmState.PAUSED_ERROR, error = e.message))
            store.saveTransferRecord(manifest, VlmState.PAUSED_ERROR, e.message)
            Result.retry()
        }
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

    companion object {
        const val CHANNEL_ID = "findback_model_download"
        const val NOTIFICATION_ID = 4201
    }
}
