package com.findback.app.vlm

import android.content.Context
import android.content.SharedPreferences

/**
 * User transfer controls persisted across restarts (pause/resume).
 * Scheduler backends (UIDT job, WorkManager) honor the paused flag so a
 * user pause sticks instead of being rescheduled behind the user's back.
 */
object TransferControls {
    private const val PREFS = "findback_vlm"
    private const val KEY_PAUSED_PREFIX = "transfer_paused_"

    fun isUserPaused(context: Context, modelId: VlmModelId): Boolean {
        return prefs(context).getBoolean(KEY_PAUSED_PREFIX + modelId.wire, false)
    }

    fun setUserPaused(context: Context, modelId: VlmModelId, paused: Boolean) {
        prefs(context).edit().putBoolean(KEY_PAUSED_PREFIX + modelId.wire, paused).apply()
    }

    private fun prefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }
}
