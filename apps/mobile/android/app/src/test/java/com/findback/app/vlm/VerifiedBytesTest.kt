package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals

class VerifiedBytesTest {

    @Test fun sumsVerifiedLayoutLengths() {
        val journal = TransferJournal("rev", 20L, 8L, setOf(0, 2), "url", null, null, 0, 0L)
        // Layout for 20 bytes @8: 8 + 8 + 4.
        assertEquals(12L, TransferJournalStore.verifiedBytes(20L, journal))
    }

    @Test fun nullOrEmptyJournalIsZero() {
        assertEquals(0L, TransferJournalStore.verifiedBytes(20L, null))
        val empty = TransferJournal("rev", 20L, 8L, emptySet(), "url", null, null, 0, 0L)
        assertEquals(0L, TransferJournalStore.verifiedBytes(20L, empty))
    }

    @Test fun revisionSizeMismatchIsZero() {
        val journal = TransferJournal("rev", 10L, 8L, setOf(0), "url", null, null, 0, 0L)
        assertEquals(0L, TransferJournalStore.verifiedBytes(20L, journal))
    }
}
