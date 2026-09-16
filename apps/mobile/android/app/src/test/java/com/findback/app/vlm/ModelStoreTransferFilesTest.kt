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
}
