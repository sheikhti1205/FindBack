package com.findback.app.vlm

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CandidateModelStatusTest {
    @Test
    fun onlyExactInstalledWeightsCanBeOfferedForVerification() {
        val root = Files.createTempDirectory("candidate-status-").toFile()
        try {
            val bytes = "fixture weights".toByteArray()
            val manifest = ModelManifest(
                id = "candidate-a", sourceRepo = "example/model", revision = "fixture-rev",
                runtime = "fixture", files = listOf(ModelFileSpec("model.litertlm", bytes.size.toLong(), PackageHost.sha256Hex(bytes)))
            )
            val store = ModelStore(root)
            assertFalse(CandidateModelStatus.hasVerifiedWeights(store, manifest))
            val staged = store.partFile(manifest, manifest.files.single())
            staged.parentFile!!.mkdirs()
            staged.writeBytes(bytes)
            assertFalse(CandidateModelStatus.hasVerifiedWeights(store, manifest), "partial file is never installed")
            val final = store.finalFile(manifest, manifest.files.single())
            final.writeBytes("tampered weights".toByteArray())
            assertFalse(CandidateModelStatus.hasVerifiedWeights(store, manifest))
            final.writeBytes(bytes)
            assertTrue(CandidateModelStatus.hasVerifiedWeights(store, manifest))
            assertEquals("INSTALLED_UNVERIFIED", CandidateModelStatus.visibleState(true, false, VlmState.NOT_INSTALLED))
            assertEquals("READY", CandidateModelStatus.visibleState(true, true, VlmState.NOT_INSTALLED))
            assertEquals("NOT_INSTALLED", CandidateModelStatus.visibleState(false, true, VlmState.NOT_INSTALLED))
        } finally {
            root.deleteRecursively()
        }
    }
}
