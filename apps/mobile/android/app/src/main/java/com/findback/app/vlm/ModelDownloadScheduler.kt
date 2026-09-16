package com.findback.app.vlm

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.net.NetworkCapabilities
import android.os.Build
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

/**
 * Platform scheduler for long model transfers.
 *
 * API 34+: Android User-Initiated Data Transfer (UIDT) via JobScheduler with
 * setUserInitiated(true), RUN_USER_INITIATED_JOBS, user-visible job
 * notification, exact estimated bytes, and network constraints.
 *
 * API 24-33: foreground-capable WorkManager CoroutineWorker fallback with a
 * foreground notification and persistent state.
 *
 * The scheduler differs; the download algorithm ([ModelDownloader] chunk
 * engine) stays shared.
 */
object ModelDownloadScheduler {

    const val EXTRA_MODEL_ID = "modelId"
    const val EXTRA_ALLOW_CELLULAR = "allowCellular"

    enum class NetworkPolicy {
        WIFI_ONLY,
        WIFI_OR_CELLULAR
    }

    fun jobIdFor(modelId: VlmModelId): Int = when (modelId) {
        VlmModelId.SMOLVLM2_500M -> 4101
        VlmModelId.SMOLVLM_256M -> 4102
    }

    fun workNameFor(modelId: VlmModelId): String = "findback-model-${modelId.wire}"

    /**
     * Schedules a transfer for [modelId]. Returns true when a backend
     * accepted the request.
     */
    fun schedule(context: Context, modelId: VlmModelId, policy: NetworkPolicy = NetworkPolicy.WIFI_ONLY): Boolean {
        return if (Build.VERSION.SDK_INT >= 34) {
            scheduleUidt(context, modelId, policy)
        } else {
            scheduleWorker(context, modelId, policy)
        }
    }

    fun cancel(context: Context, modelId: VlmModelId) {
        if (Build.VERSION.SDK_INT >= 34) {
            (context.getSystemService(JobScheduler::class.java))?.cancel(jobIdFor(modelId))
        }
        WorkManager.getInstance(context).cancelUniqueWork(workNameFor(modelId))
    }

    // ---- UIDT (API 34+) ----

    private fun scheduleUidt(context: Context, modelId: VlmModelId, policy: NetworkPolicy): Boolean {
        if (Build.VERSION.SDK_INT < 34) return false
        val manifest = MODEL_MANIFESTS.singleOrNull { it.id == modelId.wire } ?: return false
        val totalBytes = manifest.files.sumOf { it.expectedBytes }
        val service = ComponentName(context, ModelDownloadJobService::class.java)
        val builder = JobInfo.Builder(jobIdFor(modelId), service)
            .setUserInitiated(true)
            .setRequiredNetwork(uidtNetworkRequest(policy))
            .setEstimatedNetworkBytes(totalBytes, totalBytes)
            .setPersisted(false)
            .setExtras(
                android.os.PersistableBundle().apply {
                    putString(EXTRA_MODEL_ID, modelId.wire)
                    putBoolean(EXTRA_ALLOW_CELLULAR, policy == NetworkPolicy.WIFI_OR_CELLULAR)
                }
            )
        val scheduler = context.getSystemService(JobScheduler::class.java) ?: return false
        return scheduler.schedule(builder.build()) == JobScheduler.RESULT_SUCCESS
    }

    /**
     * UIDT network constraints: Wi-Fi-only (default) requires INTERNET +
     * NOT_METERED; explicit cellular opt-in requires INTERNET only.
     */
    fun uidtNetworkRequest(policy: NetworkPolicy): android.net.NetworkRequest {
        val builder = android.net.NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        if (policy == NetworkPolicy.WIFI_ONLY) {
            builder.addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        }
        return builder.build()
    }

    // ---- WorkManager fallback (API 24-33) ----

    private fun scheduleWorker(context: Context, modelId: VlmModelId, policy: NetworkPolicy): Boolean {
        val request = OneTimeWorkRequestBuilder<ModelDownloadWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(workNetworkType(policy))
                    .build()
            )
            .setInputData(
                Data.Builder()
                    .putString(EXTRA_MODEL_ID, modelId.wire)
                    .putBoolean(EXTRA_ALLOW_CELLULAR, policy == NetworkPolicy.WIFI_OR_CELLULAR)
                    .build()
            )
            .addTag(workNameFor(modelId))
            .build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(workNameFor(modelId), ExistingWorkPolicy.KEEP, request)
        return true
    }

    /**
     * WorkManager network constraints mirroring the UIDT policy:
     * Wi-Fi-only -> UNMETERED, cellular opt-in -> CONNECTED.
     * `@capacitor/network` stays live-UI-connectivity only; background
     * transfer gating uses these native constraints.
     */
    fun workNetworkType(policy: NetworkPolicy): NetworkType = when (policy) {
        NetworkPolicy.WIFI_ONLY -> NetworkType.UNMETERED
        NetworkPolicy.WIFI_OR_CELLULAR -> NetworkType.CONNECTED
    }
}
