package com.findback.app.vlm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build
import androidx.annotation.RequiresApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * API 34+ User-Initiated Data Transfer job running the shared chunk engine.
 * Shows the required user-visible job notification via the JobService
 * notification API; reports model, true MB/MB, percentage, state, and
 * completion ("Download complete — integrity verified") or pause
 * ("Download paused"). ETA is never faked: none is shown.
 */
@RequiresApi(34)
class ModelDownloadJobService : JobService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // Two models can have jobs scheduled; never let one overwrite the other.
    // Keyed by the scheduler job id so stop/cancel always hits the right job.
    private val activeJobs = ConcurrentHashMap<Int, Job>()
    private val downloaders = ConcurrentHashMap<Int, ModelDownloader>()

    override fun onStartJob(params: JobParameters): Boolean {
        val modelWire = params.extras?.getString(ModelDownloadScheduler.EXTRA_MODEL_ID)
        val modelId = modelWire?.let { VlmModelId.fromWire(it) } ?: run {
            jobFinished(params, false)
            return false
        }
        val jobId = params.jobId
        val store = ModelStore.create(this)
        val engine = ModelDownloader(this, store)
        downloaders[jobId] = engine
        val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
        val totalBytes = manifest.files.sumOf { it.expectedBytes }

        if (TransferControls.isUserPaused(this, modelId)) {
            TransferEvents.emit(TransferEvent(modelId, VlmState.PAUSED, 0L, totalBytes))
            store.saveTransferRecord(manifest, VlmState.PAUSED)
            downloaders.remove(jobId)
            jobFinished(params, false)
            return false
        }

        setNotification(
            params,
            notificationIdFor(modelId),
            buildNotification(modelId, "Starting…", 0L, totalBytes),
            JOB_END_NOTIFICATION_POLICY_DETACH
        )
        TransferEvents.emit(TransferEvent(modelId, VlmState.QUEUED, 0L, totalBytes))
        store.saveTransferRecord(manifest, VlmState.QUEUED)

        activeJobs[jobId] = scope.launch {
            val throttler = ProgressThrottler()
            try {
                TransferEvents.emit(TransferEvent(modelId, VlmState.DOWNLOADING, 0L, totalBytes))
                store.saveTransferRecord(manifest, VlmState.DOWNLOADING)
                val finalState = engine.download(
                    manifest = manifest,
                    onProgress = { downloaded, total ->
                        TransferEvents.emit(TransferEvent(modelId, VlmState.DOWNLOADING, downloaded, total))
                        // Throttled: chunk callbacks far outnumber useful UI updates.
                        if (throttler.shouldEmit(downloaded, System.currentTimeMillis())) {
                            updateNotification(modelId, downloaded, total)
                        }
                    },
                    onState = { transferState ->
                        TransferEvents.emit(TransferEvent(modelId, transferState))
                        store.saveTransferRecord(manifest, transferState)
                    }
                )
                TransferEvents.emit(TransferEvent(modelId, finalState))
                store.saveTransferRecord(manifest, finalState)
                showTerminalNotification(modelId, finalState)
            } catch (e: CancellationException) {
                // System stop / explicit cancel: not a failure. Verified
                // chunks and the journal are preserved; report PAUSED.
                TransferEvents.emit(TransferEvent(modelId, VlmState.PAUSED, 0L, totalBytes))
                store.saveTransferRecord(manifest, VlmState.PAUSED)
                showTerminalNotification(modelId, VlmState.PAUSED)
                throw e
            } catch (e: Exception) {
                val state = VlmState.PAUSED_ERROR
                TransferEvents.emit(TransferEvent(modelId, state, error = e.message))
                store.saveTransferRecord(manifest, state, e.message)
            } finally {
                activeJobs.remove(jobId)
                downloaders.remove(jobId)
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        // Job interruption (process pressure, constraint loss): stop gracefully,
        // preserve verified chunks via journal. Reschedule only when the user
        // did not pause (a user pause must stick).
        val jobId = params.jobId
        downloaders[jobId]?.requestPause()
        activeJobs.remove(jobId)?.cancel()
        downloaders.remove(jobId)
        val modelWire = params.extras?.getString(ModelDownloadScheduler.EXTRA_MODEL_ID)
        val modelId = modelWire?.let { VlmModelId.fromWire(it) }
        if (modelId != null) {
            TransferEvents.emit(TransferEvent(modelId, VlmState.PAUSED))
            return !TransferControls.isUserPaused(this, modelId)
        }
        return true
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun updateNotification(modelId: VlmModelId, downloaded: Long, total: Long) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val percent = if (total > 0) (downloaded * 100 / total).toInt() else 0
        val text = "${downloaded / (1024 * 1024)} / ${total / (1024 * 1024)} MB · $percent%"
        nm.notify(NOTIFICATION_TAG, notificationIdFor(modelId), buildNotification(modelId, text, downloaded, total))
    }

    private fun showTerminalNotification(modelId: VlmModelId, state: VlmState) {
        val nm = getSystemService(NotificationManager::class.java) ?: return
        val text = when (state) {
            VlmState.INSTALLED_UNVERIFIED -> "Download complete — integrity verified"
            VlmState.PAUSED, VlmState.PAUSED_ERROR -> "Download paused"
            VlmState.INSUFFICIENT_STORAGE -> "Download paused — storage full"
            VlmState.MANIFEST_MISMATCH -> "Download stopped — source mismatch"
            else -> "Download ${state.wire.lowercase().replace('_', ' ')}"
        }
        val manifest = MODEL_MANIFESTS.singleOrNull { it.id == modelId.wire }
        val total = manifest?.files?.sumOf { it.expectedBytes } ?: 0L
        // Terminal entries are dismissible, never ongoing.
        nm.notify(NOTIFICATION_TAG, notificationIdFor(modelId), buildNotification(modelId, text, total, total, ongoing = false))
    }

    private fun buildNotification(
        modelId: VlmModelId,
        text: String,
        downloaded: Long,
        total: Long,
        ongoing: Boolean = true
    ): Notification {
        ensureChannel()
        val title = "Downloading ${modelId.wire}"
        val progress = if (total > 0) (downloaded * 100 / total).toInt().coerceIn(0, 100) else 0
        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setProgress(100, progress, total <= 0)
            .setOngoing(ongoing)
        if (!ongoing && Build.VERSION.SDK_INT >= 26) {
            builder.setAutoCancel(true)
        }
        return builder.build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Model downloads", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    companion object {
        const val CHANNEL_ID = "findback_model_download"
        const val NOTIFICATION_TAG = "findback-model"
        const val TRANSFER_NOTIFICATION_ID = 4201

        /** Per-model notification id so two transfers never share one entry. */
        fun notificationIdFor(modelId: VlmModelId): Int =
            TRANSFER_NOTIFICATION_ID + modelId.ordinal
    }
}
