package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ModelStoreTransferFilesTest {
    private fun root(): File = File.createTempFile("findback-models", "").apply { delete(); mkdirs() }

    @Test fun journalAndChunkTmpPaths() {
        val store = ModelStore(root())
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        val spec = manifest.files.first()
        assertEquals(
            File(store.dirFor(manifest), "${spec.path}.journal.json"),
            store.journalFile(manifest, spec)
        )
        assertEquals(
            File(store.dirFor(manifest), "${spec.path}.chunk.tmp"),
            store.chunkTmpFile(manifest, spec)
        )
    }

    @Test fun transferRecordPersistsPerModelWithoutTouchingOther() {
        val store = ModelStore(root())
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        store.saveTransferRecord(manifest, VlmState.QUEUED)
        assertEquals(VlmState.QUEUED, store.loadRecord(VlmModelId.SMOLVLM2_500M)?.state)
        store.saveTransferRecord(manifest, VlmState.DOWNLOADING)
        assertEquals(VlmState.DOWNLOADING, store.loadRecord(VlmModelId.SMOLVLM2_500M)?.state)
        // Other model untouched.
        assertEquals(null, store.loadRecord(VlmModelId.SMOLVLM_256M))
        assertTrue(store.journalFile(manifest, manifest.files.first()).parentFile != null)
    }

    @Test fun transferRecordUsesVerifiedBytesNotPartLength() {
        val store = ModelStore(root())
        val spec = ModelFileSpec("tiny.bin", 8L, TestHashes.sha256Of("whole"))
        val manifest = ModelManifest("test-model", "repo", "rev", listOf(spec), "runtime")
        // Preallocated .part at full length with garbage: must not leak in.
        val part = store.partFile(manifest, spec)
        part.parentFile?.mkdirs()
        part.writeBytes(ByteArray(8) { 0x7F })
        // Journal says only chunk 0 of 2x4 verified.
        TransferJournalStore.saveAtomic(
            store.journalFile(manifest, spec),
            TransferJournal("rev", 8L, 4L, setOf(0), "url", null, null, 0, 0L)
        )
        store.saveTransferRecord(manifest, VlmState.DOWNLOADING, modelId = VlmModelId.SMOLVLM2_500M)
        val record = store.loadRecord(VlmModelId.SMOLVLM2_500M)!!
        assertEquals(4L, record.files.single().installedBytes)
        // No whole-file verification yet: no installed SHA.
        assertEquals("", record.files.single().installedSha256)
    }

    @Test fun promotePartToFinalAtomicallyReplaces() {
        val store = ModelStore(root())
        val bytes = "verified-content".toByteArray()
        val spec = ModelFileSpec("tiny.bin", bytes.size.toLong(), TestHashes.sha256Of(String(bytes)))
        val manifest = ModelManifest("test-model", "repo", "rev", listOf(spec), "runtime")
        val part = store.partFile(manifest, spec)
        part.parentFile?.mkdirs()
        part.writeBytes(bytes)
        assertTrue(store.promotePartToFinal(manifest, spec))
        val final = store.finalFile(manifest, spec)
        assertTrue(final.exists())
        assertEquals(String(bytes), final.readText())
        assertTrue(!part.exists())
    }

    @Test fun promoteRejectsUnverifiedPartAndKeepsGoodFinal() {
        val store = ModelStore(root())
        val good = "good-content".toByteArray()
        val spec = ModelFileSpec("tiny.bin", good.size.toLong(), TestHashes.sha256Of(String(good)))
        val manifest = ModelManifest("test-model", "repo", "rev", listOf(spec), "runtime")
        val final = store.finalFile(manifest, spec)
        final.parentFile?.mkdirs()
        final.writeBytes(good)
        // Garbage part with the right length but wrong hash: never promoted.
        val part = store.partFile(manifest, spec)
        part.writeBytes(ByteArray(good.size) { 0x01 })
        assertEquals(false, store.promotePartToFinal(manifest, spec))
        assertEquals(String(good), final.readText())
    }

    @Test fun promoteQuarantinesInvalidFinalAside() {
        val store = ModelStore(root())
        val good = "good-content".toByteArray()
        val spec = ModelFileSpec("tiny.bin", good.size.toLong(), TestHashes.sha256Of(String(good)))
        val manifest = ModelManifest("test-model", "repo", "rev", listOf(spec), "runtime")
        // Stale invalid final (right length, wrong bytes).
        val final = store.finalFile(manifest, spec)
        final.parentFile?.mkdirs()
        final.writeBytes(ByteArray(good.size) { 0x02 })
        val part = store.partFile(manifest, spec)
        part.writeBytes(good)
        assertTrue(store.promotePartToFinal(manifest, spec))
        assertEquals(String(good), final.readText())
    }
}
