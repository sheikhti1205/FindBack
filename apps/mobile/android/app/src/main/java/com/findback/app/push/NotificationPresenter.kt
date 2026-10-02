package com.findback.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.findback.app.MainActivity
import com.findback.app.R

/**
 * Builds and posts the system notification for a data-only FCM message. Kept
 * behind one class so the reply action wiring lives in a single place.
 */
class NotificationPresenter(private val context: Context) {

    fun show(push: PushData) {
        if (!notificationsAllowed()) return
        ensureChannel()
        val manager = NotificationManagerCompat.from(context)
        manager.notify(PushData.notificationIdFor(push), build(push))
    }

    /**
     * Replaces the notification body after an inline reply succeeds/fails.
     * `keepReply` retains the RemoteInput action so a transient failure leaves
     * the user a one-tap retry instead of stranding the reply.
     */
    fun updateStatus(push: PushData, text: String, keepReply: Boolean = false) {
        if (!notificationsAllowed()) return
        ensureChannel()
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_findback)
            .setContentTitle(push.title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(contentIntent(push))
        if (keepReply && push.canReply) builder.addAction(replyAction(push))
        NotificationManagerCompat.from(context).notify(PushData.notificationIdFor(push), builder.build())
    }

    private fun build(push: PushData): android.app.Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_findback)
            .setContentTitle(push.title)
            .setContentText(push.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(push.body))
            .setAutoCancel(true)
            .setContentIntent(contentIntent(push))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
        if (push.canReply) builder.addAction(replyAction(push))
        return builder.build()
    }

    private fun replyAction(push: PushData): NotificationCompat.Action {
        val intent = Intent(context, ReplyReceiver::class.java).apply {
            action = ReplyReceiver.ACTION_REPLY
            data = Uri.parse("findback://reply/${push.notificationId}")
            putExtra(ReplyReceiver.EXTRA_REPLY_TOKEN, push.replyToken)
            putExtra(ReplyReceiver.EXTRA_POST_ID, push.postId)
            putExtra(ReplyReceiver.EXTRA_URL, push.url)
            putExtra(ReplyReceiver.EXTRA_COMMENT_ID, push.commentId)
            putExtra(ReplyReceiver.EXTRA_NOTIFICATION_ID, push.notificationId)
        }
        // RemoteInput needs a mutable PendingIntent on API 31+.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        val pending = PendingIntent.getBroadcast(context, PushData.notificationIdFor(push), intent, flags)
        val remoteInput = RemoteInput.Builder(ReplyReceiver.KEY_REPLY_TEXT)
            .setLabel(context.getString(R.string.findback_reply_label))
            .build()
        return NotificationCompat.Action.Builder(
            R.drawable.ic_stat_findback,
            context.getString(R.string.findback_reply_label),
            pending,
        )
            .addRemoteInput(remoteInput)
            .setAllowGeneratedReplies(true)
            .build()
    }

    private fun contentIntent(push: PushData): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(push.url), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(context, PushData.notificationIdFor(push), intent, flags)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.findback_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.findback_channel_description)
        }
        manager.createNotificationChannel(channel)
    }

    private fun notificationsAllowed(): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    companion object {
        // Must match FINDBACK_PUSH_CHANNEL.id in the web client.
        const val CHANNEL_ID = "findback_updates"
    }
}
