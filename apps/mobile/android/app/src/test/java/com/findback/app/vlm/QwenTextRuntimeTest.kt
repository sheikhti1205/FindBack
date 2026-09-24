package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class QwenTextRuntimeTest {

    @Test fun pinMatchesQualifiedInstalledArtifact() {
        assertEquals("Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm", QwenTextRuntime.MODEL_FILE_NAME)
        assertEquals("a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76", QwenTextRuntime.REVISION)
        assertEquals(344671744L, QwenTextRuntime.INSTALLED_BYTES)
        assertEquals(
            "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
            QwenTextRuntime.INSTALLED_SHA256
        )
        assertEquals("qwen3-0.6b", QwenTextRuntime.BRIDGE_MODEL_ID)
        assertEquals("qwen3-0.6b-litert-dynamic-int4", QwenTextRuntime.ENTRY_ID)
    }

    @Test fun acceptsOnlyExactBridgeModelId() {
        assertTrue(QwenTextRuntime.isAcceptedModelId("qwen3-0.6b"))
        assertEquals("qwen3-0.6b", QwenTextRuntime.requireAcceptedModelId("qwen3-0.6b"))
    }

    @Test fun rejectsEveryOtherModelId() {
        val rejected = listOf(
            null,
            "",
            " ",
            "QWEN3-0.6B",
            "qwen3-0.6b-litert-dynamic-int4",
            "qwen3-0.6b-dynamic-int4",
            "smolvlm2-500m",
            "smolvlm-500m",
            "smolvlm-256m",
            "qwen3-0.6b-int8",
            "qwen3-0.6b "
        )
        for (modelId in rejected) {
            assertFalse(
                QwenTextRuntime.isAcceptedModelId(modelId),
                "must reject modelId=${modelId ?: "<null>"}"
            )
            assertFailsWith<IllegalArgumentException>(
                "must reject modelId=${modelId ?: "<null>"}"
            ) {
                QwenTextRuntime.requireAcceptedModelId(modelId)
            }
        }
    }

    @Test fun rejectionNamesExpectedId() {
        val failure = assertFailsWith<IllegalArgumentException> {
            QwenTextRuntime.requireAcceptedModelId("smolvlm2-500m")
        }
        assertTrue(failure.message!!.contains("qwen3-0.6b"))
    }

    @Test fun manifestCarriesInstalledIdentityAndDistributionPin() {
        val manifest = QwenTextRuntime.manifest()
        assertEquals("qwen3-0.6b-litert-dynamic-int4", manifest.id)
        assertEquals("litert-community/Qwen3-0.6B", manifest.sourceRepo)
        assertEquals("a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76", manifest.revision)
        assertEquals("com.google.ai.edge.litertlm:litertlm-android:0.16.0", manifest.runtime)
        val file = manifest.files.single()
        assertEquals("Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm", file.path)
        assertEquals(344671744L, file.expectedBytes)
        assertEquals(
            "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856",
            file.sha256
        )
        val distribution = manifest.distribution
        assertEquals("sheikhti1205/FindBack-Models", distribution!!.repo)
        assertEquals("models-2026-09-22-v1", distribution.tag)
        assertEquals("qwen3-0.6b-litert-dynamic-int4.fbmodel", distribution.asset)
        assertEquals(344672709L, distribution.bytes)
        assertEquals(
            "83109b67d59e349e7fdbd178a4742030656813edd9442c8713ca71b38e4a1efb",
            distribution.sha256
        )
        assertEquals(DistributionState.PUBLISHED, distribution.state)
        assertNull(distribution.parts)
    }

    @Test fun distributionUrlUsesPinnedReleaseAsset() {
        val manifest = QwenTextRuntime.manifest()
        assertEquals(
            "https://github.com/sheikhti1205/FindBack-Models/releases/download/models-2026-09-22-v1/qwen3-0.6b-litert-dynamic-int4.fbmodel",
            distributionUrlFor(manifest.distribution!!)
        )
    }

    @Test fun manifestIsRegisteredAlongsideVlmEntries() {
        val entry = MODEL_MANIFESTS.single { it.id == "qwen3-0.6b-litert-dynamic-int4" }
        assertEquals(QwenTextRuntime.REVISION, entry.revision)
        assertEquals(QwenTextRuntime.INSTALLED_BYTES, entry.files.single().expectedBytes)
        // The VLM image entries are untouched by the text registration.
        assertEquals(360822960L, MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }.files.single().expectedBytes)
    }
}
