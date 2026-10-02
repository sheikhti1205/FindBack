package com.findback.app.push

import org.json.JSONObject

/**
 * Data-only FCM payload for one FindBack notification.
 *
 * push-dispatch deliberately sends no `notification` block so this app owns
 * presentation and can attach the RemoteInput reply action. These helpers are
 * pure so they are exercised on the JVM without an emulator.
 */
data class PushData(
    val title: String,
    val body: String,
    val type: String,
    val postId: String,
    val url: String,
    val notificationId: String,
    val commentId: String?,
    val replyToken: String?,
) {
    /** Only comment notifications with a parent comment and a minted token reply inline. */
    val canReply: Boolean
        get() = type == TYPE_COMMENT && !commentId.isNullOrBlank() && !replyToken.isNullOrBlank()

    companion object {
        const val TYPE_COMMENT = "COMMENT"
        const val MAX_REPLY_LENGTH = 1000
        const val DEFAULT_TITLE = "FindBack"
        const val DEFAULT_BODY = "New activity on your report"

        /**
         * Parses a RemoteMessage data map. Returns null when the payload is not a
         * FindBack report notification (no report id or no allowlisted URL), so a
         * malformed or foreign message never produces a notification.
         */
        fun fromData(data: Map<String, String>): PushData? {
            val postId = data["postId"]?.trim().orEmpty()
            val url = data["url"]?.trim().orEmpty()
            if (postId.isEmpty() || url.isEmpty()) return null
            if (!url.startsWith("https://")) return null
            val notificationId = data["notificationId"]?.trim().orEmpty().ifEmpty { postId }
            return PushData(
                title = data["title"]?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE,
                body = data["body"]?.takeIf { it.isNotBlank() } ?: DEFAULT_BODY,
                type = data["type"].orEmpty(),
                postId = postId,
                url = url,
                notificationId = notificationId,
                commentId = data["commentId"]?.trim()?.takeIf { it.isNotEmpty() },
                replyToken = data["replyToken"]?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

        /** Stable notification id derived from the server-side notification id. */
        fun notificationIdFor(push: PushData): Int = push.notificationId.hashCode()
    }
}

/** Trim + length check mirroring the reply-comment function's 1-1000 rule. */
fun validReplyText(text: String?): String? {
    val trimmed = text?.trim().orEmpty()
    if (trimmed.isEmpty() || trimmed.length > PushData.MAX_REPLY_LENGTH) return null
    return trimmed
}

/** JSON body for the reply-comment Edge Function; token + text only. */
fun replyRequestJson(replyToken: String, body: String): String {
    val json = JSONObject()
    json.put("token", replyToken)
    json.put("body", body)
    return json.toString()
}
