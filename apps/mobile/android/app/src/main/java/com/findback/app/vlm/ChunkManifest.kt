package com.findback.app.vlm

/**
 * Trusted per-chunk hash descriptor for an 8 MiB chunked transfer manifest.
 *
 * Real chunk hashes are generated from the exact pinned immutable model
 * source and are never invented. Trusted manifests are bundled under
 * `assets/chunks/` (see PROVENANCE.md) and loaded via the
 * context-aware [ChunkManifest.chunksFor] overload; callers fall back to
 * the legacy whole-file path only when no manifest is bundled.
 */
data class ChunkSpec(
    val index: Int,
    val offset: Long,
    val length: Long,
    val sha256: String
)

/**
 * Outcome of validating a chunk layout for exact coverage.
 */
sealed class ChunkLayoutValidation {
    data object Ok : ChunkLayoutValidation()
    data class Gap(val expectedOffset: Long, val actualOffset: Long) : ChunkLayoutValidation()
    data class Overlap(val expectedOffset: Long, val actualOffset: Long) : ChunkLayoutValidation()
    data class SizeMismatch(val expectedBytes: Long, val coveredBytes: Long) : ChunkLayoutValidation()
    data class BadIndex(val expectedIndex: Int, val actualIndex: Int) : ChunkLayoutValidation()
    data class BadLength(val index: Int) : ChunkLayoutValidation()
    data class BadHash(val index: Int) : ChunkLayoutValidation()
}

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
     * Legacy overload without an Android context: always empty (no asset
     * access possible). Production code must use the
     * [chunksFor]-with-context overload below, which loads the trusted
     * manifests bundled under `assets/chunks/` (see PROVENANCE.md).
     */
    fun chunksFor(spec: ModelFileSpec): List<ChunkSpec> = emptyList()

    /**
     * Loads trusted chunks for [spec] from a generated JSON manifest bundled
     * under `assets/chunks/` (added by tooling from the exact pinned model
     * source), or empty when no manifest is bundled (legacy path). The file
     * name is `<manifest.id>__<sanitized spec.path>.json`.
     */
    fun chunksFor(
        context: android.content.Context,
        manifest: ModelManifest,
        spec: ModelFileSpec
    ): List<ChunkSpec> {
        val json = try {
            context.assets.open("chunks/${bundledName(manifest, spec)}")
                .bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            return emptyList()
        }
        return chunksFromManifestJson(json, spec)
    }

    fun bundledName(manifest: ModelManifest, spec: ModelFileSpec): String {
        val sanitized = spec.path.map { ch ->
            if (ch.isLetterOrDigit() || ch == '.' || ch == '-') ch else '_'
        }.joinToString("")
        return "${manifest.id}__$sanitized.json"
    }

    /**
     * Parses [json] (produced by [toJson]) and returns trusted chunks only
     * when the header matches [spec] exactly and the layout validates.
     * Returns empty on any mismatch so callers fall back to the legacy path.
     */
    fun chunksFromManifestJson(json: String, spec: ModelFileSpec): List<ChunkSpec> {
        val path = Regex("\"path\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
            .find(json)?.groupValues?.get(1) ?: return emptyList()
        val expectedBytes = Regex("\"expectedBytes\"\\s*:\\s*(\\d+)")
            .find(json)?.groupValues?.get(1)?.toLongOrNull() ?: return emptyList()
        val sha = Regex("\"sha256\"\\s*:\\s*\"([^\"]*)\"")
            .find(json)?.groupValues?.get(1) ?: return emptyList()
        if (path != spec.path) return emptyList()
        if (expectedBytes != spec.expectedBytes) return emptyList()
        if (!sha.equals(spec.sha256, ignoreCase = true)) return emptyList()
        val chunks = parseJson(json)
        if (chunks.isEmpty()) return emptyList()
        return if (validateLayout(spec.expectedBytes, chunks) is ChunkLayoutValidation.Ok) {
            chunks
        } else {
            emptyList()
        }
    }

    /**
     * Validates chunk layout: contiguous indexes from 0, no gaps, no
     * overlaps, exact coverage of `[0, expectedBytes)`, positive lengths,
     * and non-blank SHA-256 hashes.
     */
    fun validateLayout(expectedBytes: Long, chunks: List<ChunkSpec>): ChunkLayoutValidation {
        if (chunks.isEmpty()) {
            return if (expectedBytes == 0L) {
                ChunkLayoutValidation.Ok
            } else {
                ChunkLayoutValidation.SizeMismatch(expectedBytes, 0L)
            }
        }
        val sorted = chunks.sortedBy { it.index }
        for ((position, chunk) in sorted.withIndex()) {
            if (chunk.index != position) {
                return ChunkLayoutValidation.BadIndex(position, chunk.index)
            }
            if (chunk.length <= 0) {
                return ChunkLayoutValidation.BadLength(chunk.index)
            }
            if (chunk.sha256.isBlank()) {
                return ChunkLayoutValidation.BadHash(chunk.index)
            }
        }
        var expectedOffset = 0L
        for (chunk in sorted) {
            if (chunk.offset > expectedOffset) {
                return ChunkLayoutValidation.Gap(expectedOffset, chunk.offset)
            }
            if (chunk.offset < expectedOffset) {
                return ChunkLayoutValidation.Overlap(expectedOffset, chunk.offset)
            }
            expectedOffset += chunk.length
        }
        if (expectedOffset != expectedBytes) {
            return ChunkLayoutValidation.SizeMismatch(expectedBytes, expectedOffset)
        }
        return ChunkLayoutValidation.Ok
    }

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
