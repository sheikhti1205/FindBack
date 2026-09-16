package com.findback.app.vlm

/**
 * Trusted per-chunk hash descriptor for an 8 MiB chunked transfer manifest.
 *
 * Real chunk hashes must be generated from the exact pinned immutable model
 * source and are never invented. This checkout ships no trusted chunk hashes
 * for the real weights, so [ChunkManifest.chunksFor] returns empty (legacy
 * whole-file path) until a generated manifest is added.
 */
data class ChunkSpec(
    val index: Int,
    val offset: Long,
    val length: Long,
    val sha256: String
)

/**
 * Chunk layout + manifest JSON helpers for the 8 MiB trusted per-chunk
 * SHA-256 manifest infrastructure (spec section 3).
 */
object ChunkManifest {
    const val DEFAULT_CHUNK_SIZE: Long = 8L * 1024L * 1024L

    /**
     * Lays out chunk ranges covering [0, expectedBytes).
     * The final chunk may be shorter; there is never an empty tail chunk.
     */
    fun chunkLayout(expectedBytes: Long, chunkSize: Long = DEFAULT_CHUNK_SIZE): List<ChunkSpec> {
        require(expectedBytes >= 0) { "expectedBytes must be >= 0" }
        require(chunkSize > 0) { "chunkSize must be > 0" }
        val chunks = mutableListOf<ChunkSpec>()
        var offset = 0L
        var index = 0
        while (offset < expectedBytes) {
            val length = minOf(chunkSize, expectedBytes - offset)
            chunks.add(ChunkSpec(index, offset, length, ""))
            offset += length
            index++
        }
        return chunks
    }

    /**
     * Returns trusted chunks for a file spec, or empty when no chunk manifest
     * is available (legacy whole-file verification path).
     */
    fun chunksFor(spec: ModelFileSpec): List<ChunkSpec> = emptyList()

    /**
     * Serializes a chunk manifest to JSON.
     */
    fun toJson(
        path: String,
        expectedBytes: Long,
        sha256: String,
        chunkSize: Long,
        chunks: List<ChunkSpec>
    ): String {
        val sb = StringBuilder()
        sb.append("{\"path\":")
        appendQuoted(sb, path)
        sb.append(",\"expectedBytes\":").append(expectedBytes)
        sb.append(",\"sha256\":")
        appendQuoted(sb, sha256)
        sb.append(",\"chunkSize\":").append(chunkSize)
        sb.append(",\"chunks\":[")
        chunks.forEachIndexed { i, chunk ->
            if (i > 0) sb.append(",")
            sb.append("{\"index\":").append(chunk.index)
            sb.append(",\"offset\":").append(chunk.offset)
            sb.append(",\"length\":").append(chunk.length)
            sb.append(",\"sha256\":")
            appendQuoted(sb, chunk.sha256)
            sb.append("}")
        }
        sb.append("]}")
        return sb.toString()
    }

    /**
     * Parses chunk specs from manifest JSON produced by [toJson].
     */
    fun parseJson(json: String): List<ChunkSpec> {
        val chunks = mutableListOf<ChunkSpec>()
        val chunkBlock = Regex("\\{[^{}]*\"index\"[^{}]*\\}").findAll(json)
        for (match in chunkBlock) {
            val block = match.value
            val index = Regex("\"index\"\\s*:\\s*(\\d+)").find(block)?.groupValues?.get(1)?.toIntOrNull()
                ?: continue
            val offset = Regex("\"offset\"\\s*:\\s*(\\d+)").find(block)?.groupValues?.get(1)?.toLongOrNull()
                ?: continue
            val length = Regex("\"length\"\\s*:\\s*(\\d+)").find(block)?.groupValues?.get(1)?.toLongOrNull()
                ?: continue
            val sha = Regex("\"sha256\"\\s*:\\s*\"([^\"]*)\"").find(block)?.groupValues?.get(1)
                ?: continue
            chunks.add(ChunkSpec(index, offset, length, sha))
        }
        return chunks.sortedBy { it.index }
    }

    private fun appendQuoted(sb: StringBuilder, value: String) {
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> sb.append(ch)
            }
        }
        sb.append('"')
    }
}
