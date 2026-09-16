package com.findback.app.vlm

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * Raw HTTP response for a single chunk Range request, decoupled from
 * HttpURLConnection so the validation logic stays unit-testable on the JVM.
 */
data class ChunkHttpResponse(
    val status: Int,
    val contentRange: String?,
    val bytes: ByteArray,
    val retryAfter: String? = null
)

/**
 * Outcome of validating one chunk Range response.
 */
sealed class ChunkValidation {
    data object Ok : ChunkValidation()
    data object BadContentRange : ChunkValidation()
    data object BadLength : ChunkValidation()
}

/**
 * Shared chunk transfer engine: Range -> 206 check -> temp -> hash ->
 * offset-write -> journal (spec section 5). Pure functions here; I/O
 * orchestration lives in [ModelDownloader].
 */
object ChunkTransferEngine {

    /**
     * Validates that a chunk response is an exact 206 with a matching
     * Content-Range and the exact expected chunk byte count.
     * Any 200 (or other status) for a chunk Range request is rejected.
     */
    fun validateChunkResponse(
        spec: ChunkSpec,
        expectedBytes: Long,
        response: ChunkHttpResponse
    ): ChunkValidation {
        if (response.status != 206) return ChunkValidation.BadContentRange
        val range = parseContentRange(response.contentRange) ?: return ChunkValidation.BadContentRange
        if (range.total != expectedBytes) return ChunkValidation.BadContentRange
        if (range.start != spec.offset) return ChunkValidation.BadContentRange
        if (range.end != spec.offset + spec.length - 1) return ChunkValidation.BadContentRange
        if (response.bytes.size.toLong() != spec.length) return ChunkValidation.BadLength
        return ChunkValidation.Ok
    }

    /**
     * Compares chunk bytes against the trusted chunk SHA-256.
     */
    fun chunkBytesMatch(bytes: ByteArray, trusted: ChunkSpec): Boolean {
        return sha256Hex(bytes) == trusted.sha256.lowercase()
    }

    /**
     * Rescans the part file against trusted chunk hashes and returns the
     * indexes of missing/bad chunks. Good bytes are never flagged.
     */
    fun scanBadChunks(partFile: File, trusted: List<ChunkSpec>): List<Int> {
        if (!partFile.exists()) return trusted.map { it.index }
        val bad = mutableListOf<Int>()
        FileInputStream(partFile).use { input ->
            var position = 0L
            for (spec in trusted) {
                // Skip forward to the chunk offset if the stream is behind.
                val skip = spec.offset - position
                if (skip > 0) {
                    var remaining = skip
                    while (remaining > 0) {
                        val skipped = input.skip(remaining)
                        if (skipped <= 0) break
                        remaining -= skipped
                        position += skipped
                    }
                }
                if (position != spec.offset) {
                    bad.add(spec.index)
                    continue
                }
                val bytes = ByteArray(spec.length.toInt())
                var read = 0
                while (read < bytes.size) {
                    val n = input.read(bytes, read, bytes.size - read)
                    if (n == -1) break
                    read += n
                }
                position += read
                if (read != bytes.size || !chunkBytesMatch(bytes, spec)) {
                    bad.add(spec.index)
                }
            }
        }
        return bad
    }

    /**
     * Decides the post-whole-hash state (spec section 7):
     * - all chunks verified yet whole SHA fails -> MANIFEST_MISMATCH, stop, no loop.
     * - otherwise whole failure with bad chunks -> REPAIR_NEEDED.
     */
    fun decideAfterWholeHash(allChunksVerified: Boolean, wholeHashMatches: Boolean): VlmState {
        if (wholeHashMatches) return VlmState.INSTALLED_UNVERIFIED
        return if (allChunksVerified) VlmState.MANIFEST_MISMATCH else VlmState.REPAIR_NEEDED
    }

    private data class ContentRange(val start: Long, val end: Long, val total: Long)

    // Content-Range: bytes <start>-<end>/<total>
    private fun parseContentRange(header: String?): ContentRange? {
        if (header == null) return null
        val parts = header.split(" ")
        if (parts.size != 2 || parts[0] != "bytes") return null
        val rangeParts = parts[1].split("/")
        if (rangeParts.size != 2) return null
        val total = rangeParts[1].toLongOrNull() ?: return null
        val startEnd = rangeParts[0].split("-")
        if (startEnd.size != 2) return null
        val start = startEnd[0].toLongOrNull() ?: return null
        val end = startEnd[1].toLongOrNull() ?: return null
        return ContentRange(start, end, total)
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
