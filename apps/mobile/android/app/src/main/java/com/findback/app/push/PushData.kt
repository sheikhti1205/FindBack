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
    /**
     * Canonical reaction kind (LOVE/HELPFUL/SUPPORT/WOW) for REACTION rows so
     * the notification can render the matching icon. Null on every other
     * type and on any non-allowlisted value (fail closed — the server
     * sanitizes upstream, this is the defense-in-depth second gate).
     */
    val kind: String?,
) {
    /** Only comment notifications with a parent comment and a minted token reply inline. */
    val canReply: Boolean
        get() = type == TYPE_COMMENT && !commentId.isNullOrBlank() && !replyToken.isNullOrBlank()

    companion object {
        const val TYPE_LIKE = "LIKE"
        const val TYPE_DISLIKE = "DISLIKE"
        /** Multi-kind reaction (W1-A): canonical kind travels in `kind`. */
        const val TYPE_REACTION = "REACTION"
        const val TYPE_COMMENT = "COMMENT"
        const val TYPE_MENTION = "MENTION"
        const val TYPE_STATUS = "STATUS"
        const val MAX_REPLY_LENGTH = 1000
        const val DEFAULT_TITLE = "FindBack"
        const val DEFAULT_BODY = "New activity on your report"
        /** Canonical reaction kinds, mirroring push-dispatch + shared schema. */
        val REACTION_KINDS = setOf("LOVE", "HELPFUL", "SUPPORT", "WOW")

        /**
         * Parses a RemoteMessage data map. Returns null when the payload is not a
         * FindBack report notification (no report id or no allowlisted URL), so a
         * malformed or foreign message never produces a notification.
         */
        fun fromData(data: Map<String, String>): PushData? {
            // Chat payloads must never fall through to report presentation, even
            // when a malformed payload also supplies report fields.
            if (data["type"].orEmpty().startsWith("CHAT_")) return null
            val postId = data["postId"]?.trim().orEmpty()
            val url = data["url"]?.trim().orEmpty()
            if (postId.isEmpty() || url.isEmpty()) return null
            if (!url.startsWith("https://")) return null
            val notificationId = data["notificationId"]?.trim().orEmpty().ifEmpty { postId }
            val type = data["type"].orEmpty()
            // Only REACTION rows carry a kind, and only an allowlisted one.
            val kind = data["reactionKind"]?.trim()?.takeIf { it.isNotEmpty() }
                ?.takeIf { type == TYPE_REACTION && REACTION_KINDS.contains(it) }
            return PushData(
                title = data["title"]?.takeIf { it.isNotBlank() } ?: DEFAULT_TITLE,
                body = data["body"]?.takeIf { it.isNotBlank() } ?: DEFAULT_BODY,
                type = type,
                postId = postId,
                url = url,
                notificationId = notificationId,
                commentId = data["commentId"]?.trim()?.takeIf { it.isNotEmpty() },
                replyToken = data["replyToken"]?.trim()?.takeIf { it.isNotEmpty() },
                kind = kind,
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
