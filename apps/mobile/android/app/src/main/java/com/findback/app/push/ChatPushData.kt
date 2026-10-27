package com.findback.app.push

/** Deliberately separate from report/reply payloads. No text or URL accepted. */
data class ChatPushData(val type: String, val recipientId: String,
                        val conversationId: String, val notificationId: String) {
    companion object {
        private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        fun fromData(data: Map<String, String>): ChatPushData? {
            if (data.keys != setOf("type", "recipientId", "conversationId", "notificationId")) return null
            val type = data["type"] ?: return null
            if (type != "CHAT_REQUEST" && type != "CHAT_CONNECTED") return null
            val recipient = data["recipientId"] ?: return null
            val conversation = data["conversationId"] ?: return null
            val notification = data["notificationId"] ?: return null
            if (!listOf(recipient, conversation, notification).all { uuid.matches(it) }) return null
            return ChatPushData(type, recipient, conversation, notification)
        }
    }
}
