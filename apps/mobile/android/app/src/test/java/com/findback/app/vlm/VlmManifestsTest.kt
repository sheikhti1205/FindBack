package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class VlmManifestsTest {
    @Test fun pinsBothModelsExactly() {
        val fiveHundred = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        assertEquals("dad030b6e56756201d670cfb4d042736a2ce3a5c", fiveHundred.revision)
        assertEquals("litert-community/SmolVLM2-500M", fiveHundred.sourceRepo)
        assertEquals("com.google.ai.edge.litertlm:litertlm-android:0.16.0", fiveHundred.runtime)
        val file500 = fiveHundred.files.single { it.path == "SmolVLM2-500M.litertlm" }
        assertEquals(360822960L, file500.expectedBytes)
        assertEquals("b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0", file500.sha256)
        val dist500 = fiveHundred.distribution
        assertNotNull(dist500)
        assertEquals("sheikhti1205/FindBack-Models", dist500.repo)
        assertEquals("models-2026-09-22-v1", dist500.tag)
        assertEquals("smolvlm2-500m-litert-int4.fbmodel", dist500.asset)
        assertEquals(360823868L, dist500.bytes)
        assertEquals("41e11106a57ae750f61d992ab195f90b9f7bc58c39009b5dac0ce9d1c60a366e", dist500.sha256)
        assertEquals(DistributionState.UNPUBLISHED, dist500.state)
        assertNull(dist500.parts)

        val twoFiftySix = MODEL_MANIFESTS.single { it.id == "smolvlm-256m" }
        assertEquals("dc16f6046d86c646bcc5dfe249c879d028f8b2f2", twoFiftySix.revision)
        assertEquals("litert-community/SmolVLM-256M-Instruct", twoFiftySix.sourceRepo)
        assertEquals("com.google.ai.edge.litert:litert:1.4.2+litert-gpu:1.4.2", twoFiftySix.runtime)
        val tfliteFile = twoFiftySix.files.single { it.path == "smolvlm-256m-instruct_q8_ekv2048_single_image.tflite" }
        assertEquals(288229208L, tfliteFile.expectedBytes)
        assertEquals("48991855eb6365aae8cd1d8fe3013e6059dfea44b4ae26dd76dfa2a942dba3c4", tfliteFile.sha256)
        val tokenizerFile = twoFiftySix.files.single { it.path == "tokenizer.model" }
        assertEquals(881895L, tokenizerFile.expectedBytes)
        assertEquals("6682f47d3b33538490b21265ba3b2a83f8d48e09dcd7f957b46b508abb427a04", tokenizerFile.sha256)
        assertNull(twoFiftySix.distribution)
    }

    @Test fun usesImmutableRevisionsOnly() {
        MODEL_MANIFESTS.forEach { manifest ->
            assertEquals(40, manifest.revision.length, "${manifest.id} revision must be a full commit")
            manifest.files.forEach { assertEquals(64, it.sha256.length, "${manifest.id}/${it.path} sha256") }
            manifest.distribution?.let { assertEquals(64, it.sha256.length, "${manifest.id} distribution sha256") }
        }
    }

    @Test fun distributionUrlUsesPinnedReleaseAsset() {
        val fiveHundred = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        val dist = fiveHundred.distribution
        assertNotNull(dist)
        assertEquals(
            "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/smolvlm2-500m-litert-int4.fbmodel",
            distributionUrlFor(dist)
        )
    }
}