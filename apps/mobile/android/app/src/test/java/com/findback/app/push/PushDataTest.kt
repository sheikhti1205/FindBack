package com.findback.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushDataTest {

    private fun valid() = mapOf(
        "title" to "FindBack",
        "body" to "New comment on your report",
        "type" to "COMMENT",
        "postId" to "p1",
        "url" to "https://findbackapp.social/r/p1",
        "notificationId" to "n1",
        "commentId" to "c1",
        "replyToken" to "A".repeat(43),
    )

    @Test
    fun `parses a comment notification`() {
        val push = PushData.fromData(valid())!!
        assertEquals("p1", push.postId)
        assertEquals("n1", push.notificationId)
        assertEquals("c1", push.commentId)
        assertTrue(push.canReply)
    }

    @Test
    fun `rejects payloads without a report id or an https url`() {
        assertNull(PushData.fromData(valid() - "postId"))
        assertNull(PushData.fromData(valid() - "url"))
        assertNull(PushData.fromData(valid() + ("url" to "http://insecure/r/p1")))
    }

    @Test
    fun `falls back to the post id when no notification id is present`() {
        val push = PushData.fromData(valid() - "notificationId")!!
        assertEquals("p1", push.notificationId)
    }

    @Test
    fun `only comment notifications with a token can reply`() {
        assertFalse(PushData.fromData(valid() - "replyToken")!!.canReply)
        assertFalse(PushData.fromData(valid() - "commentId")!!.canReply)
        assertFalse(PushData.fromData(valid() + ("type" to "LIKE"))!!.canReply)
    }

    @Test
    fun `notification id is stable for the same notification`() {
        val a = PushData.fromData(valid())!!
        val b = PushData.fromData(valid())!!
        assertEquals(PushData.notificationIdFor(a), PushData.notificationIdFor(b))
    }

    @Test
    fun `validReplyText trims and enforces the length limit`() {
        assertEquals("hello", validReplyText("  hello  "))
        assertNull(validReplyText("   "))
        assertNull(validReplyText(null))
        assertEquals("x".repeat(1000), validReplyText("x".repeat(1000)))
        assertNull(validReplyText("x".repeat(1001)))
    }

    @Test
    fun `reply body is valid JSON with the token and escaped text`() {
        val json = replyRequestJson("tok", "say \"hi\"\nnow")
        assertTrue(json.contains("\"token\":\"tok\""))
        assertTrue(json.contains("say \\\"hi\\\"\\nnow"))
    }
}
