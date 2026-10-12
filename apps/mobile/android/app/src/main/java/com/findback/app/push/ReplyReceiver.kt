package com.findback.app.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import com.findback.app.BuildConfig
import com.findback.app.R
import java.net.HttpURLConnection
import java.net.URL

/**
 * Receives the RemoteInput reply text from the notification shade and posts it to
 * the reply-comment Edge Function using the single-use token carried in the FCM
 * payload. Runs off the main thread via goAsync().
 */
class ReplyReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_REPLY) return
        val results = RemoteInput.getResultsFromIntent(intent) ?: return
        val text = validReplyText(results.getCharSequence(KEY_REPLY_TEXT)?.toString()) ?: return
        val token = intent.getStringExtra(EXTRA_REPLY_TOKEN)?.takeIf { it.isNotBlank() } ?: return
        val push = intent.toPushData(token) ?: return

        val pendingResult = goAsync()
        Thread {
            try {
                val posted = postReply(token, text)
                val presenter = NotificationPresenter(context)
                presenter.updateStatus(
                    push,
                    context.getString(if (posted) R.string.findback_reply_sent else R.string.findback_reply_failed),
                    // Failure keeps the reply action so the user can retry inline.
                    keepReply = !posted,
                )
            } finally {
                pendingResult.finish()
            }
        }.start()
    }

    private fun Intent.toPushData(token: String): PushData? {
        val postId = getStringExtra(EXTRA_POST_ID)?.takeIf { it.isNotBlank() } ?: return null
        val url = getStringExtra(EXTRA_URL)?.takeIf { it.isNotBlank() } ?: return null
        val commentId = getStringExtra(EXTRA_COMMENT_ID)
        return PushData(
            title = "FindBack",
            body = "Reply",
            type = PushData.TYPE_COMMENT,
            postId = postId,
            url = url,
            notificationId = getStringExtra(EXTRA_NOTIFICATION_ID)?.takeIf { it.isNotBlank() } ?: postId,
            commentId = commentId,
            replyToken = token,
            kind = null,
        )
    }

    private fun postReply(token: String, text: String): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(BuildConfig.REPLY_ENDPOINT).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 15_000
                readTimeout = 15_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            connection.outputStream.use { it.write(replyRequestJson(token, text).toByteArray(Charsets.UTF_8)) }
            connection.responseCode in 200..299
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }

    companion object {
        const val ACTION_REPLY = "com.findback.app.push.ACTION_REPLY"
        const val KEY_REPLY_TEXT = "findback_reply_text"
        const val EXTRA_REPLY_TOKEN = "replyToken"
        const val EXTRA_POST_ID = "postId"
        const val EXTRA_URL = "url"
        const val EXTRA_COMMENT_ID = "commentId"
        const val EXTRA_NOTIFICATION_ID = "notificationId"
    }
}
