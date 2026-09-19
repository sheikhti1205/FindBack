package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ModelStoreTest {
    private fun root(): File = File.createTempFile("findback-models", "").apply { delete(); mkdirs() }

    @Test fun storesEachModelUnderItsOwnRevisionDirectory() {
        val store = ModelStore(root())
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        assertEquals(File(store.root, "smolvlm2-500m/${manifest.revision}"), store.dirFor(manifest))
        assertEquals(File(store.root, "smolvlm2-500m/${manifest.revision}/SmolVLM2-500M.litertlm.part"),
            store.partFile(manifest, manifest.files.first()))
    }

    @Test fun persistsAndReloadsState() {
        val store = ModelStore(root())
        assertNull(store.loadRecord(VlmModelId.SMOLVLM2_500M))
        store.saveRecord(ModelStateRecord(VlmModelId.SMOLVLM2_500M, VlmState.READY_GPU,
            listOf(InstalledFileRecord("model", 1L, 1L, "hash", "hash")), 1L, 2L, "0.16.0",
            "0.1.0", "fp", "arm64-v8a", "Qualcomm", "Adreno", "rev", "hash", 3L, null))
        assertEquals(VlmState.READY_GPU, store.loadRecord(VlmModelId.SMOLVLM2_500M)?.state)
        assertEquals("Qualcomm", store.loadRecord(VlmModelId.SMOLVLM2_500M)?.gpuVendor)
        assertEquals(3L, store.loadRecord(VlmModelId.SMOLVLM2_500M)?.lastGpuSelfTest)
    }

    @Test fun transferRecordUsesStoreAppVersionWhenNoPrevious() {
        val store = ModelStore(root(), appVersion = "0.1.0")
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        store.saveTransferRecord(manifest, VlmState.QUEUED)
        assertEquals("0.1.0", store.loadRecord(VlmModelId.SMOLVLM2_500M)?.appVersion)
    }

    @Test fun transferRecordKeepsPreviousAppVersion() {
        val store = ModelStore(root(), appVersion = "0.1.0")
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        store.saveRecord(ModelStateRecord(VlmModelId.SMOLVLM2_500M, VlmState.DOWNLOADING,
            emptyList(), 0L, 1L, manifest.runtime, "0.0.9", "fp", "arm64-v8a",
            null, null, manifest.revision, "", null, null))
        store.saveTransferRecord(manifest, VlmState.DOWNLOADING)
        assertEquals("0.0.9", store.loadRecord(VlmModelId.SMOLVLM2_500M)?.appVersion)
    }

    @Test fun transferRecordWithoutVersionFallsBackToUnknown() {
        val store = ModelStore(root())
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        store.saveTransferRecord(manifest, VlmState.QUEUED)
        assertEquals("unknown", store.loadRecord(VlmModelId.SMOLVLM2_500M)?.appVersion)
    }
}