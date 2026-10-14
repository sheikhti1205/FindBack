package com.findback.app.ai

import org.junit.Assert.*
import org.junit.Test

class ThoughtEnvelopeTest {
    @Test fun stripsCompleteEnvelopeBeforeProse() {
        val stripped = ThoughtEnvelope.strip("[thought]reasoning here[/thought]The lost wallet is brown.")
        assertEquals("The lost wallet is brown.", stripped)
        assertTrue(ThoughtEnvelope.isClean(stripped))
    }

    @Test fun unclosedThoughtTruncatesToHonestEmpty() {
        // T11-style thought-only output: no answer exists, so the honest
        // result is empty — never a reasoning fragment.
        val stripped = ThoughtEnvelope.strip("[thought]only reasoning, no answer")
        assertEquals("", stripped)
        assertTrue(ThoughtEnvelope.isClean(stripped))
    }

    @Test fun removesMultipleEnvelopes() {
        val stripped = ThoughtEnvelope.strip("[thought]a[/thought]Hello[thought]b[/thought] world")
        assertEquals("Hello world", stripped)
    }

    @Test fun leavesPlainProseByteIdentical() {
        val prose = "Found: black umbrella near the gate."
        assertEquals(prose, ThoughtEnvelope.strip(prose))
    }

    @Test fun removesStrayCloser() {
        assertEquals("answer", ThoughtEnvelope.strip("answer[/thought]"))
    }

    @Test fun envelopeAcrossNewlines() {
        val stripped = ThoughtEnvelope.strip("[thought]\nline1\nline2\n[/thought]\nDone.")
        assertEquals("Done.", stripped)
    }
}
