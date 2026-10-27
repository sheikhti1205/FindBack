package com.findback.app.push

import org.junit.Assert.*
import org.junit.Test

class ChatPushDataTest {
    private val data = mapOf("type" to "CHAT_REQUEST",
        "recipientId" to "11111111-1111-4111-8111-111111111111",
        "conversationId" to "22222222-2222-4222-8222-222222222222",
        "notificationId" to "33333333-3333-4333-8333-333333333333")

    @Test fun `only exact content free chat variants parse`() {
        assertNotNull(ChatPushData.fromData(data))
        assertNotNull(ChatPushData.fromData(data + ("type" to "CHAT_CONNECTED")))
        assertNull(ChatPushData.fromData(data + ("type" to "CHAT_UNKNOWN")))
        assertNull(ChatPushData.fromData(data + ("body" to "private")))
        assertNull(ChatPushData.fromData(data + ("conversationId" to "../signin")))
        assertNull(ChatPushData.fromData(data - "recipientId"))
        assertNull(PushData.fromData(data + ("url" to "https://findbackapp.social/r/p1") + ("postId" to "p1")))
    }
}
