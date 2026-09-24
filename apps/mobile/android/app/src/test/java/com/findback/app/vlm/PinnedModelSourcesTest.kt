package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PinnedModelSourcesTest {
    @Test
    fun fourExperimentalEntriesUseDistinctImmutableRawWeightIdentities() {
        val expected = mapOf(
            "qwen3-0.6b-litert-mixed-int4" to Pair(497516544L, "7900eb4e7362d88c58782c6f9999bb7a129e03544aa98b8f338ea0cc5d8c22c1"),
            "qwen3-0.6b-litert-int8" to Pair(614236160L, "555579ff2f4fd13379abe69c1c3ab5200f7338bc92471557f1d6614a6e5ab0b4"),
            "lfm2.5-1.2b-instruct-litert-int4-gpu" to Pair(736220768L, "97e6a9700208f59fce2ceb993cd6c18ea77ada8c2a940f68332004f38a404671"),
            "lfm2.5-vl-450m" to Pair(406817104L, "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033")
        )
        assertEquals(expected.keys, PinnedModelSources.manifests.map { it.id }.toSet())
        for ((id, pin) in expected) {
            val manifest = PinnedModelSources.manifests.single { it.id == id }
            assertNull(manifest.distribution, "Raw weights are not a release package")
            assertEquals(pin.first, manifest.files.single().expectedBytes)
            assertEquals(pin.second, manifest.files.single().sha256)
            assertEquals(pin.second, manifest.rawSource?.sha256)
            assertEquals(manifest.files.single().path, manifest.rawSource?.file)
            assertTrue(manifest.rawSource!!.url().startsWith("https://huggingface.co/"))
            assertFalse(manifest.rawSource!!.url().contains("/main/"))
            assertTrue(ModelDownloader.isRawDownloadPermitted(manifest))
        }
    }

    @Test
    fun releaseOnlyAndSpoofedRawManifestsCannotImpersonatePinnedSource() {
        assertFalse(ModelDownloader.isRawDownloadPermitted(QwenTextRuntime.manifest()))
        val pinned = PinnedModelSources.manifests.first()
        assertFalse(ModelDownloader.isRawDownloadPermitted(pinned.copy(id = QwenTextRuntime.ENTRY_ID)))
        assertFalse(ModelDownloader.isRawDownloadPermitted(pinned.copy(files = pinned.files.map { it.copy(sha256 = "f".repeat(64)) })))
    }

    @Test
    fun rawRedirectsStayOnApprovedHttpsModelHosts() {
        assertTrue(PinnedRawSource.isApprovedUrl("https://huggingface.co/litert-community/Qwen3-0.6B/resolve/abc/model.litertlm"))
        assertTrue(PinnedRawSource.isApprovedUrl("https://cas-bridge.xethub.hf.co/path?X-Amz-Signature=abc"))
        assertFalse(PinnedRawSource.isApprovedUrl("http://huggingface.co/model"))
        assertFalse(PinnedRawSource.isApprovedUrl("https://huggingface.co.evil.example/model"))
        assertFalse(PinnedRawSource.isApprovedUrl("https://example.org/model"))
    }
}
