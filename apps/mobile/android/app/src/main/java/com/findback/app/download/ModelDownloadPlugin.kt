package com.findback.app.download

import android.os.StatFs
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Production model downloader: streams HTTPS model weights straight into
 * staged app-private storage with an inline SHA-256 digest — model bytes
 * never transit the JS bridge.
 *
 * - `startDownload` runs the whole loop natively (manual https-only
 *   redirects, Range resume, byte bound, crash-safe v1 journal, throttled
 *   progress events) and resolves once with the completion record.
 * - `cancelDownload` aborts an in-flight download; staged bytes and the
 *   last flushed journal are kept for a byte-exact resume.
 * - `sha256File` / `fileSize` / `freeBytes` / `deleteFile` /
 *   `promoteFile` are the TS driver primitives (verify, resume truth,
 *   storage gate, idempotent delete, atomic install).
 *
 * The v1 journal JSON matches TS `download/journal.ts` field-for-field so
 * either side can read what the other wrote.
 */
@CapacitorPlugin(name = "FindbackModelDownload")
class ModelDownloadPlugin : Plugin() {

    private val active = ConcurrentHashMap<String, DownloadTask>()

    @PluginMethod
    fun startDownload(call: PluginCall) {
        val url = call.getString("url")
        val stagingPath = call.getString("stagingPath")
        if (url.isNullOrBlank() || stagingPath.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val key = downloadKey(stagingPath)
        if (active.containsKey(key)) {
            call.reject("download_busy")
            return
        }
        val task = DownloadTask(
            downloadId = call.getString("downloadId", key) ?: key,
            url = url,
            stagingFile = File(stagingPath),
            journalPath = call.getString("journalPath"),
            resumeOffset = call.getLong("resumeOffset", 0L) ?: 0L,
            expectedSha256 = call.getString("expectedSha256", "") ?: "",
            maxBytes = call.getLong("maxBytes", DEFAULT_MAX_BYTES) ?: DEFAULT_MAX_BYTES,
            modelId = call.getString("modelId", "") ?: "",
            revision = call.getString("revision", "") ?: "",
            fileName = call.getString("fileName", "") ?: "",
        )
        active[key] = task
        call.setKeepAlive(true)
        Thread(
            {
                try {
                    val result = task.run { received, total ->
                        val event = JSObject()
                        event.put("downloadId", task.downloadId)
                        event.put("received", received)
                        if (total != null) event.put("total", total)
                        notifyListeners("downloadProgress", event)
                    }
                    val ret = JSObject()
                    ret.put("received", result.received)
                    if (result.total != null) ret.put("total", result.total)
                    ret.put("actualSha256", result.actualHex)
                    ret.put("finalUrl", result.finalUrl)
                    call.resolve(ret)
                } catch (e: DownloadFailed) {
                    call.reject(e.code, e.message)
                } catch (e: Exception) {
                    Log.w(TAG, "download failed", e)
                    call.reject("download_failed", e.message?.take(400))
                } finally {
                    active.remove(key)
                }
            },
            "findback-download",
        ).start()
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val stagingPath = call.getString("stagingPath")
        if (stagingPath.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val task = active.remove(downloadKey(stagingPath))
        if (task == null) {
            call.resolve()
            return
        }
        task.cancelled.set(true)
        task.connection?.disconnect()
        val ret = JSObject()
        ret.put("cancelled", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun sha256File(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val file = File(path)
        if (!isUnderAppFiles(file) || !file.isFile) {
            call.reject("file_missing")
            return
        }
        try {
            val ret = JSObject()
            ret.put("sha256", sha256HexOf(file))
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("hash_failed", e.message?.take(200))
        }
    }

    @PluginMethod
    fun fileSize(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val file = File(path)
        val ret = JSObject()
        ret.put("size", if (isUnderAppFiles(file) && file.isFile) file.length() else -1L)
        call.resolve(ret)
    }

    @PluginMethod
    fun freeBytes(call: PluginCall) {
        val path = call.getString("path", context.filesDir.absolutePath)
            ?: context.filesDir.absolutePath
        try {
            val stat = StatFs(File(path).let { if (it.exists()) it.absolutePath else context.filesDir.absolutePath })
            val ret = JSObject()
            ret.put("freeBytes", stat.availableBytes)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("storage_probe_failed", e.message?.take(200))
        }
    }

    @PluginMethod
    fun deleteFile(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val file = File(path)
        if (isUnderAppFiles(file)) {
            try {
                file.delete()
            } catch (_: Exception) {
            }
        }
        call.resolve()
    }

    @PluginMethod
    fun promoteFile(call: PluginCall) {
        val from = call.getString("from")
        val to = call.getString("to")
        if (from.isNullOrBlank() || to.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val src = File(from)
        val dst = File(to)
        if (!isUnderAppFiles(src) || !isUnderAppFiles(dst) || !src.isFile) {
            call.reject("file_missing")
            return
        }
        try {
            dst.parentFile?.mkdirs()
            val tmp = File("${dst.absolutePath}.tmp")
            if (tmp.exists()) tmp.delete()
            if (!src.renameTo(tmp)) {
                call.reject("promote_failed")
                return
            }
            if (!tmp.renameTo(dst)) {
                tmp.renameTo(src)
                call.reject("promote_failed")
                return
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("promote_failed", e.message?.take(200))
        }
    }

    private fun downloadKey(stagingPath: String): String = "dl:$stagingPath"

    private fun sha256HexOf(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(BUFFER_SIZE)
            while (true) {
                val read = input.read(buf)
                if (read <= 0) break
                digest.update(buf, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun isUnderAppFiles(file: File): Boolean {
        return try {
            val base = context.filesDir.canonicalPath
            val target = file.canonicalPath
            target == base || target.startsWith("$base/")
        } catch (_: Exception) {
            false
        }
    }

    class DownloadFailed(val code: String, message: String) : Exception(message)

    data class DownloadResult(
        val received: Long,
        val total: Long?,
        val actualHex: String,
        val finalUrl: String,
    )

    inner class DownloadTask(
        val downloadId: String,
        val url: String,
        val stagingFile: File,
        val journalPath: String?,
        val resumeOffset: Long,
        val expectedSha256: String,
        val maxBytes: Long,
        val modelId: String,
        val revision: String,
        val fileName: String,
    ) {
        val cancelled = AtomicBoolean(false)
        @Volatile var connection: HttpURLConnection? = null

        fun run(onProgress: (received: Long, total: Long?) -> Unit): DownloadResult {
            if (resumeOffset < 0) throw DownloadFailed("OFFSET_MISMATCH", "resume offset must be >= 0")
            if (!DownloadPolicy.isHttps(url)) throw DownloadFailed("REDIRECT_NON_HTTPS", "download URL must be https")

            // Resume truth reconciled BEFORE the network: the fetch starts
            // where the staged file actually ends. A torn file ahead of the
            // journal is truncated; a short file restarts the fetch at its
            // real end (never a gap).
            stagingFile.parentFile?.mkdirs()
            val existing = if (stagingFile.isFile) stagingFile.length() else 0L
            val offset = minOf(resumeOffset, existing)

            var current = url
            var redirects = 0
            var response: HttpURLConnection? = null
            try {
                while (true) {
                    throwIfCancelled()
                    val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                        instanceFollowRedirects = false
                        connectTimeout = CONNECT_TIMEOUT_MS
                        readTimeout = READ_TIMEOUT_MS
                        setRequestProperty("User-Agent", USER_AGENT)
                        if (offset > 0) setRequestProperty("Range", "bytes=$offset-")
                    }
                    connection = conn
                    val status = conn.responseCode
                    if (status in REDIRECT_STATUSES) {
                        val location = conn.headerFields.entries
                            .firstOrNull { it.key.equals("Location", ignoreCase = true) }
                            ?.value?.firstOrNull()
                        conn.disconnect()
                        if (location.isNullOrBlank()) {
                            throw DownloadFailed("HTTP_ERROR", "redirect $status without location")
                        }
                        current = DownloadPolicy.resolveRedirect(current, location)
                            ?: throw DownloadFailed("REDIRECT_NON_HTTPS", "refusing non-https redirect")
                        redirects += 1
                        if (redirects > MAX_REDIRECTS) {
                            throw DownloadFailed("TOO_MANY_REDIRECTS", "too many redirects (max $MAX_REDIRECTS)")
                        }
                        continue
                    }
                    response = conn
                    break
                }

                val conn = response!!
                val status = conn.responseCode
                if (status != 200 && status != 206) {
                    throw DownloadFailed("HTTP_ERROR", "download failed with HTTP $status")
                }
                val total: Long? = if (offset > 0) {
                    if (status == 200) {
                        throw DownloadFailed(
                            "RESUME_NOT_SUPPORTED",
                            "server ignored Range resume; refusing to restart over staged bytes",
                        )
                    }
                    DownloadPolicy.parseTotalFromContentRange(
                        conn.getHeaderField("Content-Range"),
                        offset,
                    ) ?: throw DownloadFailed("OFFSET_MISMATCH", "server Content-Range does not match resume offset")
                } else {
                    conn.getHeaderField("Content-Length")?.toLongOrNull()
                        ?.takeIf { it >= 0 }
                }
                if (total != null && offset + total > maxBytes) {
                    throw DownloadFailed(
                        "BYTE_BOUND_EXCEEDED",
                        "download size ${offset + total} exceeds byte bound $maxBytes",
                    )
                }

                val digest = MessageDigest.getInstance("SHA-256")
                // The running digest restarts from byte 0 over the kept
                // prefix (hash state cannot resume mid-stream), then folds
                // incoming bytes as they stream.
                if (stagingFile.isFile && offset > 0) {
                    stagingFile.inputStream().use { input ->
                        val buf = ByteArray(BUFFER_SIZE)
                        var remaining = offset
                        while (remaining > 0) {
                            val read = input.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                            if (read <= 0) break
                            digest.update(buf, 0, read)
                            remaining -= read
                        }
                    }
                }
                var received = 0L
                var sinceJournal = 0L
                var lastProgressMs = 0L
                RandomAccessFile(stagingFile, "rw").use { out ->
                    out.setLength(offset)
                    out.seek(offset)
                    conn.inputStream.use { input ->
                        val buf = ByteArray(BUFFER_SIZE)
                        var lastJournal = offset
                        while (true) {
                            throwIfCancelled()
                            val read = input.read(buf)
                            if (read <= 0) break
                            if (offset + received + read > maxBytes) {
                                throw DownloadFailed(
                                    "BYTE_BOUND_EXCEEDED",
                                    "download exceeded byte bound $maxBytes while streaming",
                                )
                            }
                            out.write(buf, 0, read)
                            digest.update(buf, 0, read)
                            received += read
                            sinceJournal += read
                            val now = System.currentTimeMillis()
                            if (now - lastProgressMs >= PROGRESS_THROTTLE_MS) {
                                lastProgressMs = now
                                onProgress(received, total)
                            }
                            if (sinceJournal >= JOURNAL_EVERY_BYTES) {
                                sinceJournal = 0
                                out.fd.sync()
                                lastJournal = offset + received
                                writeJournal(lastJournal, total)
                            }
                        }
                        out.fd.sync()
                    }
                }
                writeJournal(offset + received, total)
                val actualHex = digest.digest().joinToString("") { "%02x".format(it) }
                onProgress(received, total)
                return DownloadResult(received, total, actualHex, current)
            } finally {
                try {
                    response?.disconnect()
                } catch (_: Exception) {
                }
                connection = null
            }
        }

        private fun throwIfCancelled() {
            if (cancelled.get()) throw DownloadFailed("ABORTED", "download cancelled")
        }

        private fun writeJournal(offset: Long, total: Long?) {
            val path = journalPath ?: return
            try {
                val tmp = File("$path.tmp")
                tmp.parentFile?.mkdirs()
                tmp.writeText(DownloadPolicy.journalJson(modelId, revision, fileName, url, offset, total, expectedSha256))
                val target = File(path)
                if (target.exists()) target.delete()
                tmp.renameTo(target)
            } catch (e: Exception) {
                Log.w(TAG, "journal write failed", e)
            }
        }
    }

    companion object {
        private const val TAG = "ModelDownload"
        private const val CONNECT_TIMEOUT_MS = 20_000
        private const val READ_TIMEOUT_MS = 60_000
        private const val BUFFER_SIZE = 64 * 1024
        private const val JOURNAL_EVERY_BYTES = 1024L * 1024L
        private const val PROGRESS_THROTTLE_MS = 100L
        private const val MAX_REDIRECTS = 3
        private const val DEFAULT_MAX_BYTES = 4L * 1024L * 1024L * 1024L
        private const val USER_AGENT = "FindBack-model-download/1.0"
        private val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)
    }
}
