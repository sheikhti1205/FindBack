package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChunkTransferEngineTest {

    private fun chunkResponse(
        status: Int,
        contentRange: String?,
        bytes: ByteArray,
        retryAfter: String? = null
    ) = ChunkHttpResponse(status, contentRange, bytes, retryAfter)

    @Test fun acceptsExact206WithCorrectContentRange() {
        val result = ChunkTransferEngine.validateChunkResponse(
            spec = ChunkSpec(1, 8L, 8L, "hash"),
            expectedBytes = 20L,
            response = chunkResponse(206, "bytes 8-15/20", ByteArray(8))
        )
        assertTrue(result is ChunkValidation.Ok)
    }

    @Test fun rejectsWrongContentRange() {
        val result = ChunkTransferEngine.validateChunkResponse(
            spec = ChunkSpec(1, 8L, 8L, "hash"),
            expectedBytes = 20L,
            response = chunkResponse(206, "bytes 0-7/20", ByteArray(8))
        )
        assertTrue(result is ChunkValidation.BadContentRange)
    }

    @Test fun rejects200ForChunkRequest() {
        val result = ChunkTransferEngine.validateChunkResponse(
            spec = ChunkSpec(1, 8L, 8L, "hash"),
            expectedBytes = 20L,
            response = chunkResponse(200, null, ByteArray(8))
        )
        assertTrue(result is ChunkValidation.BadContentRange)
    }

    @Test fun rejectsShortChunkBody() {
        val result = ChunkTransferEngine.validateChunkResponse(
            spec = ChunkSpec(0, 0L, 8L, "hash"),
            expectedBytes = 20L,
            response = chunkResponse(206, "bytes 0-7/20", ByteArray(4))
        )
        assertTrue(result is ChunkValidation.BadLength)
    }

    @Test fun hashMismatchMarksChunkBad() {
        val trusted = ChunkSpec(0, 0L, 4L, TestHashes.sha256Of("good"))
        assertFalse(ChunkTransferEngine.chunkBytesMatch("badd".toByteArray(), trusted))
        assertTrue(ChunkTransferEngine.chunkBytesMatch("good".toByteArray(), trusted))
    }

    @Test fun repairScanFindsOneBadChunk() {
        val dir = File.createTempFile("repair", "").apply { delete(); mkdirs() }
        val part = File(dir, "m.part")
        part.writeBytes("good".toByteArray() + "badd".toByteArray())
        val trusted = listOf(
            ChunkSpec(0, 0L, 4L, TestHashes.sha256Of("good")),
            ChunkSpec(1, 4L, 4L, TestHashes.sha256Of("fine"))
        )
        assertEquals(listOf(1), ChunkTransferEngine.scanBadChunks(part, trusted))
    }

    @Test fun repairScanFindsManyBadChunks() {
        val dir = File.createTempFile("repairN", "").apply { delete(); mkdirs() }
        val part = File(dir, "m.part")
        part.writeBytes("xxxx".toByteArray() + "yyyy".toByteArray())
        val trusted = listOf(
            ChunkSpec(0, 0L, 4L, TestHashes.sha256Of("aaaa")),
            ChunkSpec(1, 4L, 4L, TestHashes.sha256Of("bbbb"))
        )
        assertEquals(listOf(0, 1), ChunkTransferEngine.scanBadChunks(part, trusted))
    }

    @Test fun manifestMismatchDetectedNoLoop() {
        // All chunks pass but whole-file hash fails -> manifest mismatch, stop.
        val decision = ChunkTransferEngine.decideAfterWholeHash(
            allChunksVerified = true,
            wholeHashMatches = false
        )
        assertEquals(VlmState.MANIFEST_MISMATCH, decision)
    }

    @Test fun repairNeededWhenWholeFailsWithBadChunks() {
        val decision = ChunkTransferEngine.decideAfterWholeHash(
            allChunksVerified = false,
            wholeHashMatches = false
        )
        assertEquals(VlmState.REPAIR_NEEDED, decision)
    }
}
