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
}
