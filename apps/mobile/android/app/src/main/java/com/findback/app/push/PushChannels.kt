package com.findback.app.push

import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.findback.app.R

/**
 * Android notification channels for FindBack.
 *
 * One channel per notification category so Android Settings lets the user mute
 * comments without losing report-activity alerts. Channel ids are stable and
 * version-suffixed (`.v1`): changing the importance/behaviour of an existing
 * channel requires a new id because Android ignores edits to a created channel.
 *
 * `findback.matches.v1` is deliberately NOT created: there is no background
 * matching source yet, and claiming the channel would be untruthful. Reserve
 * the id, create it only when a real source ships.
 */
object PushChannels {
    const val GROUP_ID = "findback"

    /** COMMENT / MENTION. */
    const val COMMENTS = "findback.comments.v1"

    /** LIKE / DISLIKE. */
    const val ACTIVITY = "findback.activity.v1"

    /** STATUS. */
    const val UPDATES = "findback.updates.v1"

    /** Reserved — not created until a real background-matching source exists. */
    const val MATCHES_RESERVED = "findback.matches.v1"

    /**
     * Pure category → channel mapping. Falls back to the updates channel for an
     * unknown type so a future server type never lands on a non-existent
     * channel (which would throw when the notification is posted).
     */
    fun channelIdFor(type: String): String = when (type) {
        PushData.TYPE_COMMENT, PushData.TYPE_MENTION -> COMMENTS
        PushData.TYPE_LIKE, PushData.TYPE_DISLIKE -> ACTIVITY
        PushData.TYPE_STATUS -> UPDATES
        else -> UPDATES
    }

    /** Idempotently creates the channel group and the three v1 channels. */
    fun ensureCreated(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannelGroup(GROUP_ID) == null) {
            manager.createNotificationChannelGroup(
                NotificationChannelGroup(GROUP_ID, context.getString(R.string.findback_channel_group)),
            )
        }
        create(context, manager, COMMENTS, R.string.findback_channel_comments, R.string.findback_channel_comments_description, NotificationManager.IMPORTANCE_HIGH)
        create(context, manager, ACTIVITY, R.string.findback_channel_activity, R.string.findback_channel_activity_description, NotificationManager.IMPORTANCE_DEFAULT)
        create(context, manager, UPDATES, R.string.findback_channel_updates, R.string.findback_channel_updates_description, NotificationManager.IMPORTANCE_DEFAULT)
    }

    private fun create(
        context: Context,
        manager: NotificationManager,
        id: String,
        nameRes: Int,
        descriptionRes: Int,
        importance: Int,
    ) {
        if (manager.getNotificationChannel(id) != null) return
        val channel = NotificationChannel(id, context.getString(nameRes), importance).apply {
            description = context.getString(descriptionRes)
            group = GROUP_ID
        }
        manager.createNotificationChannel(channel)
    }

    fun notificationsAllowed(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return androidx.core.content.ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
    }
}
