package com.findback.app.push

import org.junit.Assert.assertEquals
import org.junit.Test

class PushChannelsTest {

    @Test
    fun `comment and mention share the high-importance comments channel`() {
        assertEquals(PushChannels.COMMENTS, PushChannels.channelIdFor(PushData.TYPE_COMMENT))
        assertEquals(PushChannels.COMMENTS, PushChannels.channelIdFor(PushData.TYPE_MENTION))
    }

    @Test
    fun `reactions use the activity channel`() {
        assertEquals(PushChannels.ACTIVITY, PushChannels.channelIdFor(PushData.TYPE_LIKE))
        assertEquals(PushChannels.ACTIVITY, PushChannels.channelIdFor(PushData.TYPE_DISLIKE))
        assertEquals(PushChannels.ACTIVITY, PushChannels.channelIdFor(PushData.TYPE_REACTION))
    }

    @Test
    fun `status uses the updates channel`() {
        assertEquals(PushChannels.UPDATES, PushChannels.channelIdFor(PushData.TYPE_STATUS))
    }

    @Test
    fun `an unknown type falls back to a channel that exists`() {
        assertEquals(PushChannels.UPDATES, PushChannels.channelIdFor("FUTURE_TYPE"))
        assertEquals(PushChannels.UPDATES, PushChannels.channelIdFor(""))
    }

    @Test
    fun `matches channel is reserved but not created`() {
        // The id is reserved; ensureCreated deliberately omits it until a real
        // background-matching source exists.
        assertEquals("findback.matches.v1", PushChannels.MATCHES_RESERVED)
    }
}
