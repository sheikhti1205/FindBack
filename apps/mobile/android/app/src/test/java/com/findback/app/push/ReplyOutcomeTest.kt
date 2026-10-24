package com.findback.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The notification-shade reply is the one place where a refusal used to be
 * indistinguishable from a broken app: every non-2xx answered `false`, so the
 * user saw "Reply failed" and retried a reply the server had deliberately
 * refused. These tests pin the classification that replaced it.
 */
class ReplyOutcomeTest {

    @Test
    fun `an accepted reply is sent`() {
        assertEquals(ReplyOutcome.Sent, replyOutcomeFor(200, null, null))
        assertEquals(ReplyOutcome.Sent, replyOutcomeFor(201, null, null))
        assertEquals(ReplyOutcome.Sent, replyOutcomeFor(299, "rate_limited", 30))
    }

    @Test
    fun `the 30 s clock refusal is a wait, using the server's own interval`() {
        assertEquals(ReplyOutcome.TooFast(30), replyOutcomeFor(429, "rate_limited", 30))
        assertEquals(ReplyOutcome.TooFast(45), replyOutcomeFor(429, "rate_limited", 45))
    }

    @Test
    fun `a 429 without a readable interval still waits rather than failing`() {
        assertEquals(ReplyOutcome.TooFast(30), replyOutcomeFor(429, null, null))
        assertEquals(ReplyOutcome.TooFast(30), replyOutcomeFor(429, "", null))
    }

    @Test
    fun `the day's ceiling is not a wait - it is the same 429 with its own reason`() {
        assertEquals(ReplyOutcome.DailyLimit, replyOutcomeFor(429, "daily_limit", null))
        // A stray retry-after must not turn a finished day into a 30 s wait.
        assertEquals(ReplyOutcome.DailyLimit, replyOutcomeFor(429, "daily_limit", 30))
    }

    @Test
    fun `a restricted account is neither a spent day nor a wait`() {
        // The zero-limit standing refusal shares no status with either limit case.
        assertEquals(ReplyOutcome.Restricted, replyOutcomeFor(403, "account_restricted", null))
        // A stray retry-after must not reclassify standing as a 30 s wait …
        assertEquals(ReplyOutcome.Restricted, replyOutcomeFor(403, "account_restricted", 30))
        // … and the reason wins even if the status drifts to 429: the copy for a
        // standing restriction says nothing about retrying, so misreporting it as a
        // wait would invite a retry that cannot succeed.
        assertEquals(ReplyOutcome.Restricted, replyOutcomeFor(429, "account_restricted", 30))
    }

    @Test
    fun `everything else stays a failure`() {
        assertEquals(ReplyOutcome.Failed, replyOutcomeFor(500, null, null))
        assertEquals(ReplyOutcome.Failed, replyOutcomeFor(400, "invalid token", null))
        assertEquals(ReplyOutcome.Failed, replyOutcomeFor(409, "used", null))
        assertEquals(ReplyOutcome.Failed, replyOutcomeFor(503, null, null))
    }

    @Test
    fun `the refusal reason is read from the body, and never invented`() {
        assertEquals("daily_limit", replyReasonFrom("""{"ok":false,"reason":"daily_limit"}"""))
        assertEquals("rate_limited", replyReasonFrom("""{"ok":false,"reason":"rate_limited"}"""))
        assertNull(replyReasonFrom("""{"ok":true}"""))
        assertNull(replyReasonFrom("""{"reason":""}"""))
        assertNull(replyReasonFrom("not json"))
        assertNull(replyReasonFrom(""))
        assertNull(replyReasonFrom(null))
    }

    @Test
    fun `only a positive whole-second retry-after is accepted`() {
        assertEquals(30, retryAfterSecondsFrom("30"))
        assertEquals(30, retryAfterSecondsFrom(" 30 "))
        assertNull(retryAfterSecondsFrom("0"))
        assertNull(retryAfterSecondsFrom("-5"))
        assertNull(retryAfterSecondsFrom("soon"))
        assertNull(retryAfterSecondsFrom(null))
    }
}
