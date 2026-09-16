package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TransferJournalTest {

    private fun tmpDir(): File = File.createTempFile("journal-test", "").apply { delete(); mkdirs() }

    private fun journal() = TransferJournal(
        revision = "rev1",
        expectedBytes = 16L,
        chunkSize = 8L,
        verifiedChunks = setOf(0),
        sourceUrl = "https://example.com/m",
        etag = "etag1",
        lastModified = null,
        retries = 1,
        updatedAtMs = 123L
    )

    @Test fun atomicWriteAndLoad() {
        val dir = tmpDir()
        val file = File(dir, "m.journal.json")
        TransferJournalStore.saveAtomic(file, journal())
        assertEquals(journal(), TransferJournalStore.load(file))
    }

    @Test fun loadMissingReturnsNull() {
        assertNull(TransferJournalStore.load(File(tmpDir(), "nope.json")))
    }

    @Test fun loadCorruptReturnsNull() {
        val dir = tmpDir()
        val file = File(dir, "bad.journal.json")
        file.writeText("{not valid json")
        assertNull(TransferJournalStore.load(file))
    }

    @Test fun rebuildByRehashingPreservesGoodChunks() {
        val dir = tmpDir()
        val part = File(dir, "m.part")
        // chunk0 = "aaaaaaaa", chunk1 = "bbbbbbbb" (8 bytes each)
        part.writeBytes("aaaaaaaa".toByteArray() + "bbbbbbbb".toByteArray())
        val trusted = listOf(
            ChunkSpec(0, 0L, 8L, TestHashes.sha256Of("aaaaaaaa")),
            ChunkSpec(1, 8L, 8L, TestHashes.sha256Of("cccccccc"))
        )
        val rebuilt = TransferJournalStore.rebuildByRehashing(
            revision = "rev1", expectedBytes = 16L, chunkSize = 8L,
            sourceUrl = "https://example.com/m", partFile = part, trusted = trusted
        )
        assertNotNull(rebuilt)
        assertEquals(setOf(0), rebuilt.verifiedChunks)
    }

    @Test fun rebuildRejectsRevisionMismatch() {
        val dir = tmpDir()
        val part = File(dir, "m.part")
        part.writeBytes("aaaaaaaa".toByteArray())
        val rebuilt = TransferJournalStore.rebuildByRehashing(
            revision = "rev2", expectedBytes = 8L, chunkSize = 8L,
            sourceUrl = "https://example.com/m", partFile = part,
            trusted = listOf(ChunkSpec(0, 0L, 8L, TestHashes.sha256Of("aaaaaaaa"))),
            expectedRevision = "rev1"
        )
        assertNull(rebuilt)
    }

    @Test fun noDeleteOfPartOnRebuild() {
        val dir = tmpDir()
        val part = File(dir, "m.part")
        part.writeBytes("xyz".toByteArray())
        TransferJournalStore.rebuildByRehashing(
            revision = "rev1", expectedBytes = 3L, chunkSize = 8L,
            sourceUrl = "https://example.com/m", partFile = part,
            trusted = listOf(ChunkSpec(0, 0L, 3L, TestHashes.sha256Of("abc")))
        )
        assertTrue(part.exists())
    }
}
