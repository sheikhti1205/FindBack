package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChunkManifestTest {

    @Test fun chunkLayout_firstMiddleFinal() {
        val chunks = ChunkManifest.chunkLayout(expectedBytes = 20L, chunkSize = 8L)
        assertEquals(3, chunks.size)
        assertEquals(ChunkSpec(0, 0L, 8L, ""), chunks[0].copy(sha256 = ""))
        assertEquals(8L, chunks[1].offset)
        assertEquals(8L, chunks[1].length)
        assertEquals(16L, chunks[2].offset)
        assertEquals(4L, chunks[2].length)
    }

    @Test fun chunkLayout_exactMultipleHasNoEmptyTail() {
        val chunks = ChunkManifest.chunkLayout(expectedBytes = 16L, chunkSize = 8L)
        assertEquals(2, chunks.size)
        assertTrue(chunks.all { it.length == 8L })
    }

    @Test fun defaultChunkSizeIs8MiB() {
        assertEquals(8L * 1024L * 1024L, ChunkManifest.DEFAULT_CHUNK_SIZE)
    }

    @Test fun emptyChunkListMeansLegacyUnavailable() {
        val spec = ModelFileSpec(path = "m", expectedBytes = 10L, sha256 = "whole")
        assertTrue(ChunkManifest.chunksFor(spec).isEmpty())
    }

    @Test fun fixtureManifestRoundTrip() {
        val chunks = listOf(
            ChunkSpec(0, 0L, 4L, TestHashes.sha256Of("aaaa")),
            ChunkSpec(1, 4L, 4L, TestHashes.sha256Of("bbbb"))
        )
        val json = ChunkManifest.toJson("model.litertlm", 8L, "whole", 8388608L, chunks)
        val parsed = ChunkManifest.parseJson(json)
        assertEquals(2, parsed.size)
        assertEquals(chunks[0], parsed[0])
    }

    @Test fun validLayoutPasses() {
        val chunks = listOf(
            ChunkSpec(0, 0L, 8L, TestHashes.sha256Of("a")),
            ChunkSpec(1, 8L, 8L, TestHashes.sha256Of("b")),
            ChunkSpec(2, 16L, 4L, TestHashes.sha256Of("c"))
        )
        assertTrue(ChunkManifest.validateLayout(20L, chunks) is ChunkLayoutValidation.Ok)
    }

    @Test fun gapDetected() {
        val chunks = listOf(
            ChunkSpec(0, 0L, 8L, TestHashes.sha256Of("a")),
            ChunkSpec(1, 12L, 8L, TestHashes.sha256Of("b"))
        )
        val result = ChunkManifest.validateLayout(20L, chunks)
        assertTrue(result is ChunkLayoutValidation.Gap)
        assertEquals(8L, (result as ChunkLayoutValidation.Gap).expectedOffset)
    }

    @Test fun overlapDetected() {
        val chunks = listOf(
            ChunkSpec(0, 0L, 8L, TestHashes.sha256Of("a")),
            ChunkSpec(1, 4L, 8L, TestHashes.sha256Of("b"))
        )
        assertTrue(ChunkManifest.validateLayout(16L, chunks) is ChunkLayoutValidation.Overlap)
    }

    @Test fun shortCoverageDetected() {
        val chunks = listOf(ChunkSpec(0, 0L, 8L, TestHashes.sha256Of("a")))
        val result = ChunkManifest.validateLayout(20L, chunks)
        assertTrue(result is ChunkLayoutValidation.SizeMismatch)
    }

    @Test fun badIndexAndHashDetected() {
        val noZero = listOf(ChunkSpec(1, 0L, 8L, TestHashes.sha256Of("a")))
        assertTrue(ChunkManifest.validateLayout(8L, noZero) is ChunkLayoutValidation.BadIndex)
        val blankHash = listOf(ChunkSpec(0, 0L, 8L, ""))
        assertTrue(ChunkManifest.validateLayout(8L, blankHash) is ChunkLayoutValidation.BadHash)
    }

    @Test fun manifestJsonAcceptedOnlyWhenHeaderAndLayoutMatch() {
        val spec = ModelFileSpec("model.litertlm", 8L, TestHashes.sha256Of("whole"))
        val chunks = listOf(
            ChunkSpec(0, 0L, 4L, TestHashes.sha256Of("aaaa")),
            ChunkSpec(1, 4L, 4L, TestHashes.sha256Of("bbbb"))
        )
        val good = ChunkManifest.toJson(spec.path, spec.expectedBytes, spec.sha256, 4L, chunks)
        assertEquals(chunks, ChunkManifest.chunksFromManifestJson(good, spec))
        val wrongSha = ChunkManifest.toJson(spec.path, spec.expectedBytes, TestHashes.sha256Of("other"), 4L, chunks)
        assertTrue(ChunkManifest.chunksFromManifestJson(wrongSha, spec).isEmpty())
        val gapped = listOf(
            ChunkSpec(0, 0L, 4L, TestHashes.sha256Of("aaaa")),
            ChunkSpec(1, 6L, 2L, TestHashes.sha256Of("bb"))
        )
        val gappedJson = ChunkManifest.toJson(spec.path, spec.expectedBytes, spec.sha256, 4L, gapped)
        assertTrue(ChunkManifest.chunksFromManifestJson(gappedJson, spec).isEmpty())
    }

    @Test fun bundledNameIsStable() {
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        assertEquals(
            "smolvlm2-500m__SmolVLM2-500M.litertlm.json",
            ChunkManifest.bundledName(manifest, manifest.files.first())
        )
    }

    private fun readBundled(manifest: ModelManifest, spec: ModelFileSpec): String {
        val file = java.io.File("src/main/assets/chunks/${ChunkManifest.bundledName(manifest, spec)}")
        assertTrue(file.exists(), "bundled chunk manifest missing: ${file.path} (see assets/chunks/PROVENANCE.md)")
        return file.readText()
    }

    @Test fun bundledManifest500M_has44TrustedChunks() {
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        val spec = manifest.files.single()
        val chunks = ChunkManifest.chunksFromManifestJson(readBundled(manifest, spec), spec)
        assertEquals(44, chunks.size)
        assertEquals(0L, chunks.first().offset)
        assertEquals(360822960L - 112816L, chunks.last().offset)
        assertEquals(112816L, chunks.last().length)
        assertEquals(360822960L, chunks.sumOf { it.length })
        assertTrue(chunks.all { it.sha256.matches(Regex("[0-9a-f]{64}")) })
        assertTrue(ChunkManifest.validateLayout(spec.expectedBytes, chunks) is ChunkLayoutValidation.Ok)
    }

    @Test fun bundledManifest256M_has35Plus1TrustedChunks() {
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm-256m" }
        val tflite = manifest.files.single { it.path.endsWith(".tflite") }
        val tfliteChunks = ChunkManifest.chunksFromManifestJson(readBundled(manifest, tflite), tflite)
        assertEquals(35, tfliteChunks.size)
        assertEquals(0L, tfliteChunks.first().offset)
        assertEquals(288229208L - 3016536L, tfliteChunks.last().offset)
        assertEquals(3016536L, tfliteChunks.last().length)
        assertEquals(288229208L, tfliteChunks.sumOf { it.length })
        assertTrue(tfliteChunks.all { it.sha256.matches(Regex("[0-9a-f]{64}")) })
        val tokenizer = manifest.files.single { it.path == "tokenizer.model" }
        val tokChunks = ChunkManifest.chunksFromManifestJson(readBundled(manifest, tokenizer), tokenizer)
        assertEquals(1, tokChunks.size)
        assertEquals(881895L, tokChunks.single().length)
    }

    @Test fun manifest256M_downloadUsesUpstreamFilename() {
        // Upstream file carries the typo `smalvlm`; the corrected-spelling
        // URL 404s ("Entry not found", verified 2026-09-18). The downloader
        // must use remotePath so the device never requests a missing file.
        val manifest = MODEL_MANIFESTS.single { it.id == "smolvlm-256m" }
        val tflite = manifest.files.single { it.path.endsWith(".tflite") }
        assertEquals("smalvlm-256m-instruct_q8_ekv2048_single_image.tflite", tflite.remotePath)
        val url = "https://huggingface.co/${manifest.sourceRepo}/resolve/${manifest.revision}/${tflite.remotePath}"
        assertTrue(url.endsWith("/smalvlm-256m-instruct_q8_ekv2048_single_image.tflite"))
    }
}
