package com.findback.app.vlm

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * Persistent transfer journal for one model file (spec section 4).
 *
 * Tracks revision, expected size, chunk size, the verified-chunk set, the
 * source URL, ETag/Last-Modified when useful, retry metadata, and last update.
 * Writes are atomic; the `.part` file is never treated as installed.
 */
data class TransferJournal(
    val revision: String,
    val expectedBytes: Long,
    val chunkSize: Long,
    val verifiedChunks: Set<Int>,
    val sourceUrl: String,
    val etag: String? = null,
    val lastModified: String? = null,
    val retries: Int = 0,
    val updatedAtMs: Long = 0L
)

/**
 * Atomic journal persistence + journal rebuild by re-hashing (spec section 6).
 * Rebuild never deletes the `.part` file.
 */
object TransferJournalStore {

    /**
     * Atomically writes the journal (temp file + rename).
     */
    fun saveAtomic(file: File, journal: TransferJournal) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(serialize(journal))
        tmp.setLastModified(journal.updatedAtMs)
        if (file.exists() && !file.delete()) {
            throw IllegalStateException("Failed to replace journal: ${file.absolutePath}")
        }
        if (!tmp.renameTo(file)) {
            throw IllegalStateException("Failed to atomically write journal: ${file.absolutePath}")
        }
    }

    /**
     * Loads the journal, or null when missing/corrupt.
     */
    fun load(file: File): TransferJournal? {
        if (!file.exists()) return null
        return try {
            deserialize(file.readText())
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Rebuilds the journal by hashing complete chunk ranges of the existing
     * `.part` file against the trusted chunk manifest. Matching chunks are
     * preserved; only missing/bad chunks are re-fetched by the caller.
     * Returns null on revision mismatch. Never deletes [partFile].
     */
    fun rebuildByRehashing(
        revision: String,
        expectedBytes: Long,
        chunkSize: Long,
        sourceUrl: String,
        partFile: File,
        trusted: List<ChunkSpec>,
        expectedRevision: String? = null
    ): TransferJournal? {
        if (expectedRevision != null && revision != expectedRevision) return null
        val verified = mutableSetOf<Int>()
        if (partFile.exists()) {
            try {
                FileInputStream(partFile).use { input ->
                    var position = 0L
                    for (spec in trusted) {
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
                        if (position != spec.offset) continue
                        val bytes = ByteArray(spec.length.toInt())
                        var read = 0
                        while (read < bytes.size) {
                            val n = input.read(bytes, read, bytes.size - read)
                            if (n == -1) break
                            read += n
                        }
                        position += read
                        if (read == bytes.size && hashMatches(bytes, spec.sha256)) {
                            verified.add(spec.index)
                        }
                    }
                }
            } catch (e: Exception) {
                // Fall through with whatever verified chunks were found.
            }
        }
        return TransferJournal(
            revision = revision,
            expectedBytes = expectedBytes,
            chunkSize = chunkSize,
            verifiedChunks = verified,
            sourceUrl = sourceUrl,
            updatedAtMs = System.currentTimeMillis()
        )
    }

    private fun serialize(journal: TransferJournal): String {
        val sb = StringBuilder()
        sb.append("{\"revision\":")
        appendQuoted(sb, journal.revision)
        sb.append(",\"expectedBytes\":").append(journal.expectedBytes)
        sb.append(",\"chunkSize\":").append(journal.chunkSize)
        sb.append(",\"verifiedChunks\":[")
        journal.verifiedChunks.sorted().forEachIndexed { i, index ->
            if (i > 0) sb.append(",")
            sb.append(index)
        }
        sb.append("],\"sourceUrl\":")
        appendQuoted(sb, journal.sourceUrl)
        sb.append(",\"etag\":")
        if (journal.etag == null) sb.append("null") else appendQuoted(sb, journal.etag)
        sb.append(",\"lastModified\":")
        if (journal.lastModified == null) sb.append("null") else appendQuoted(sb, journal.lastModified)
        sb.append(",\"retries\":").append(journal.retries)
        sb.append(",\"updatedAtMs\":").append(journal.updatedAtMs)
        sb.append("}")
        return sb.toString()
    }

    private fun deserialize(json: String): TransferJournal? {
        fun stringField(name: String): String? {
            val match = Regex("\"$name\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").find(json)
                ?: return null
            return unescape(match.groupValues[1])
        }
        fun longField(name: String): Long? {
            return Regex("\"$name\"\\s*:\\s*(-?\\d+)").find(json)?.groupValues?.get(1)?.toLongOrNull()
        }
        fun intField(name: String): Int? {
            return Regex("\"$name\"\\s*:\\s*(-?\\d+)").find(json)?.groupValues?.get(1)?.toIntOrNull()
        }
        fun nullableStringField(name: String): String? {
            if (Regex("\"$name\"\\s*:\\s*null").containsMatchIn(json)) return null
            return stringField(name)
        }
        val revision = stringField("revision") ?: return null
        val expectedBytes = longField("expectedBytes") ?: return null
        val chunkSize = longField("chunkSize") ?: return null
        val sourceUrl = stringField("sourceUrl") ?: return null
        val retries = intField("retries") ?: return null
        val updatedAtMs = longField("updatedAtMs") ?: return null
        val verifiedRaw = Regex("\"verifiedChunks\"\\s*:\\s*\\[([^\\]]*)\\]").find(json)
            ?.groupValues?.get(1) ?: return null
        val verified = verifiedRaw.split(",").mapNotNull { it.trim().takeIf { s -> s.isNotEmpty() }?.toIntOrNull() }.toSet()
        val etagPresent = json.contains("\"etag\"")
        val lastModifiedPresent = json.contains("\"lastModified\"")
        if (!etagPresent || !lastModifiedPresent) return null
        return TransferJournal(
            revision = revision,
            expectedBytes = expectedBytes,
            chunkSize = chunkSize,
            verifiedChunks = verified,
            sourceUrl = sourceUrl,
            etag = nullableStringField("etag"),
            lastModified = nullableStringField("lastModified"),
            retries = retries,
            updatedAtMs = updatedAtMs
        )
    }

    private fun hashMatches(bytes: ByteArray, sha256: String): Boolean {
        val digest = MessageDigest.getInstance("SHA-256")
        val actual = digest.digest(bytes).joinToString("") { "%02x".format(it) }
        return actual == sha256.lowercase()
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

    private fun unescape(value: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < value.length) {
            val ch = value[i]
            if (ch == '\\' && i + 1 < value.length) {
                when (value[i + 1]) {
                    '\\' -> sb.append('\\')
                    '"' -> sb.append('"')
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    else -> sb.append(value[i + 1])
                }
                i += 2
            } else {
                sb.append(ch)
                i++
            }
        }
        return sb.toString()
    }
}
