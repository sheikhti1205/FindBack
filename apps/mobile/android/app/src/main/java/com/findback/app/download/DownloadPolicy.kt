package com.findback.app.download

import java.net.URL

/**
 * Pure download policy shared by [ModelDownloadPlugin]: https gate,
 * redirect resolution, Content-Range parsing, and the v1 journal JSON
 * (field-for-field with TS `download/journal.ts`). Dependency-free so the
 * rules stay JVM-testable without network or storage.
 */
object DownloadPolicy {
    const val MAX_REDIRECTS = 3

    fun isHttps(url: String): Boolean {
        return try {
            val parsed = URL(url)
            parsed.protocol == "https" && parsed.userInfo == null && parsed.port == -1
        } catch (_: Exception) {
            false
        }
    }

    fun safeSource(url: String): Boolean = try {
        val parsed = URL(url)
        isHttps(url) && parsed.ref == null && (parsed.query == null || parsed.query == "download=true") &&
            parsed.host.contains('.') && !parsed.host.matches(Regex("[0-9.]+")) &&
            !parsed.host.endsWith(".local") && !parsed.host.endsWith(".internal")
    } catch (_: Exception) { false }

    fun publicDestination(url: String): Boolean = try {
        val addresses = java.net.InetAddress.getAllByName(URL(url).host)
        addresses.isNotEmpty() && addresses.none { it.isAnyLocalAddress || it.isLoopbackAddress || it.isLinkLocalAddress || it.isSiteLocalAddress || it.isMulticastAddress }
    } catch (_: Exception) { false }

    fun redirectAllowed(source: String, target: String): Boolean = try {
        val origin = URL(source).host
        val host = URL(target).host
        isHttps(target) && (host == origin || (origin in listOf("hf.co", "huggingface.co") &&
            (host == "huggingface.co" || host.endsWith(".hf.co") || host.endsWith(".huggingface.co"))))
    } catch (_: Exception) { false }

    /**
     * Resolve a redirect `Location` against the current URL. Null when the
     * target is not https (refuse) or unparsable.
     */
    fun resolveRedirect(current: String, location: String): String? {
        return try {
            val next = URL(URL(current), location).toString()
            if (isHttps(next)) next else null
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Total file size from a `Content-Range` header (`bytes
     * <start>-<end>/<total>`), requiring `start == expectedStart`. Null on
     * any mismatch or on a star-total (unknown total).
     */
    fun parseTotalFromContentRange(header: String?, expectedStart: Long): Long? {
        if (header.isNullOrBlank()) return null
        val match = Regex("""^bytes (\d+)-(\d+)/(\d+|\*)$""").matchEntire(header.trim())
            ?: return null
        val start = match.groupValues[1].toLongOrNull() ?: return null
        if (start != expectedStart) return null
        val total = match.groupValues[3]
        if (total == "*") return null
        return total.toLongOrNull()?.takeIf { it >= 0 }
    }

    /**
     * v1 journal JSON (`<staging>.journal.json`). Keys mirror TS
     * `buildJournal`: v, modelId, revision, filePath, url, offset, total,
     * sha, updatedAt.
     */
    fun journalJson(
        modelId: String,
        revision: String,
        filePath: String,
        url: String,
        offset: Long,
        total: Long?,
        sha: String,
        updatedAtIso: String,
    ): String {
        fun esc(value: String): String = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
        val totalJson = total?.toString() ?: "null"
        return "{\"v\":1," +
            "\"modelId\":\"${esc(modelId)}\"," +
            "\"revision\":\"${esc(revision)}\"," +
            "\"filePath\":\"${esc(filePath)}\"," +
            "\"url\":\"${esc(url)}\"," +
            "\"offset\":$offset," +
            "\"total\":$totalJson," +
            "\"sha\":\"${esc(sha)}\"," +
            "\"updatedAt\":\"${esc(updatedAtIso)}\"}"
    }

    fun journalJson(
        modelId: String,
        revision: String,
        filePath: String,
        url: String,
        offset: Long,
        total: Long?,
        sha: String,
    ): String = journalJson(modelId, revision, filePath, url, offset, total, sha, currentIso())

    private fun currentIso(): String {
        val fmt = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
        fmt.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return fmt.format(java.util.Date())
    }
}
