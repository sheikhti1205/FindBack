package com.findback.app.vlm

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Persistence mechanics for the entry-keyed text transfer-state
 * record (workset AA, storage only). Asserts atomic read/write
 * behavior; lifecycle meaning of every value stays with the caller.
 */
class TextTransferStateTest {

    private fun root(): File = Files.createTempDirectory("aa-text-state").toFile()

    private fun record(entryId: String = QwenTextRuntime.ENTRY_ID): TextTransferState =
        TextTransferState(
            entryId = entryId,
            revision = "fixture-rev-01",
            state = VlmState.INSTALLED_UNVERIFIED,
            installedBytes = 1234L,
            installedSha256 = "ab".repeat(32),
            installTimestamp = 1758412800000L
        )

    @Test fun roundTripsRecordAtomically() {
        val dir = root()
        val file = TextTransferStateStore.fileFor(dir, QwenTextRuntime.ENTRY_ID)
        assertEquals(File(dir, "${QwenTextRuntime.ENTRY_ID}/text-state.json"), file)
        TextTransferStateStore.saveAtomic(file, record())
        assertEquals(record(), TextTransferStateStore.load(file))
        assertFalse(
            File(file.parentFile, "${file.name}.tmp").exists(),
            "atomic write must leave no temp file behind"
        )
    }

    @Test fun returnsNullWhenMissing() {
        val file = TextTransferStateStore.fileFor(root(), QwenTextRuntime.ENTRY_ID)
        assertNull(TextTransferStateStore.load(file))
    }

    @Test fun returnsNullWhenCorrupt() {
        val dir = root()
        val file = TextTransferStateStore.fileFor(dir, QwenTextRuntime.ENTRY_ID)
        file.parentFile?.mkdirs()
        file.writeText("not json {{{")
        assertNull(TextTransferStateStore.load(file))
        file.writeText("{\"entryId\": \"${QwenTextRuntime.ENTRY_ID}\"}")
        assertNull(TextTransferStateStore.load(file))
        file.writeText(
            "{\"entryId\": \"${QwenTextRuntime.ENTRY_ID}\", \"revision\": \"r\", " +
                "\"state\": \"NO_SUCH_STATE\", \"installedBytes\": 1, " +
                "\"installTimestamp\": 2, \"installedSha256\": \"aa\"}"
        )
        assertNull(TextTransferStateStore.load(file))
    }

    @Test fun replacesExistingRecord() {
        val dir = root()
        val file = TextTransferStateStore.fileFor(dir, QwenTextRuntime.ENTRY_ID)
        TextTransferStateStore.saveAtomic(file, record())
        val updated = record().copy(state = VlmState.NOT_INSTALLED, lastError = "deleted")
        TextTransferStateStore.saveAtomic(file, updated)
        assertEquals(updated, TextTransferStateStore.load(file))
    }

    @Test fun entriesAreIndependent() {
        val dir = root()
        val first = TextTransferStateStore.fileFor(dir, "entry-one")
        val second = TextTransferStateStore.fileFor(dir, "entry-two")
        TextTransferStateStore.saveAtomic(first, record("entry-one"))
        assertNull(TextTransferStateStore.load(second))
        TextTransferStateStore.saveAtomic(second, record("entry-two").copy(state = VlmState.DOWNLOADING))
        assertEquals(VlmState.INSTALLED_UNVERIFIED, TextTransferStateStore.load(first)?.state)
        assertEquals(VlmState.DOWNLOADING, TextTransferStateStore.load(second)?.state)
    }

    @Test fun rejectsUnsafeEntryId() {
        val dir = root()
        assertFailsWith<IllegalArgumentException> { TextTransferStateStore.fileFor(dir, "../evil") }
        assertFailsWith<IllegalArgumentException> { TextTransferStateStore.fileFor(dir, "") }
        assertFailsWith<IllegalArgumentException> { TextTransferStateStore.fileFor(dir, "a/b") }
        assertTrue(TextTransferStateStore.fileFor(dir, QwenTextRuntime.ENTRY_ID).isAbsolute)
    }
}
