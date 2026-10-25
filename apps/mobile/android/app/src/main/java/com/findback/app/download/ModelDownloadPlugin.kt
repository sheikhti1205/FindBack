package com.findback.app.download

import android.os.StatFs
import android.os.Build
import android.util.Log
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.JSObject
import com.getcapacitor.JSArray
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
    private val imports = ConcurrentHashMap<String, AtomicBoolean>()

    /** Download/run eligibility must not depend on an optional model plugin. */
    @PluginMethod
    fun supportedAbis(call: PluginCall) {
        call.resolve(JSObject().put("abis", JSArray(Build.SUPPORTED_ABIS.toList())))
    }

    @PluginMethod
    fun pickAndStage(call: PluginCall) {
        val path = call.getString("stagingPath")
        if (path == null || !isUnderAppFiles(File(path))) { call.reject("Invalid staging path", "BAD_URI"); return }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivityForResult(call, intent, "documentPicked")
    }

    @ActivityCallback
    private fun documentPicked(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK) { call.reject("Import cancelled", "ABORTED"); return }
        if (uri?.scheme != "content") { call.reject("Choose a document", "BAD_URI"); return }
        val path = call.getString("stagingPath") ?: run { call.reject("Invalid staging path", "BAD_URI"); return }
        val file = File(path)
        if (!isUnderAppFiles(file)) { call.reject("Invalid staging path", "BAD_URI"); return }
        val cap = (call.getLong("maxBytes", DEFAULT_MAX_BYTES) ?: DEFAULT_MAX_BYTES).coerceAtMost(DEFAULT_MAX_BYTES)
        val expectedBytes = call.getLong("expectedBytes")
        val expectedSha = call.getString("expectedSha256")
        val flag = AtomicBoolean(false)
        if (imports.putIfAbsent(path, flag) != null) { call.reject("Import busy", "IMPORT_BUSY"); return }
        Thread({
            try {
                // Storage preflight uses the ACTUAL document size, never the
                // 4 GB safety ceiling: query OpenableColumns.SIZE (falling
                // back to the asset descriptor length) and gate on
                // size + headroom. Only when the provider reports no usable
                // size do we start streaming on headroom alone; the per-chunk
                // checks below and the hard cap still bound that path.
                if (expectedBytes != null) {
                    if (expectedBytes <= 0 || StatFs(context.filesDir.absolutePath).availableBytes < expectedBytes + JOURNAL_EVERY_BYTES) throw DownloadFailed("INSUFFICIENT_STORAGE", "Needs more storage")
                } else {
                    val declared = queryDocumentSize(uri)
                    if (declared != null && declared > 0) {
                        if (declared > cap) throw DownloadFailed("SIZE_MISMATCH", "Document exceeds byte limit")
                        if (StatFs(context.filesDir.absolutePath).availableBytes < declared + JOURNAL_EVERY_BYTES) throw DownloadFailed("INSUFFICIENT_STORAGE", "Needs more storage")
                    } else if (StatFs(context.filesDir.absolutePath).availableBytes < JOURNAL_EVERY_BYTES) throw DownloadFailed("INSUFFICIENT_STORAGE", "Needs more storage")
                }
                file.parentFile?.mkdirs()
                val digest = MessageDigest.getInstance("SHA-256")
                var size = 0L
                context.contentResolver.openInputStream(uri)!!.use { input ->
                    java.io.FileOutputStream(file).use { output ->
                        val buf = ByteArray(BUFFER_SIZE)
                        while (true) {
                            if (flag.get()) throw DownloadFailed("ABORTED", "Import cancelled")
                            val read = input.read(buf)
                            if (read <= 0) break
                            size += read
                            if (size > cap) throw DownloadFailed("SIZE_MISMATCH", "Document exceeds byte limit")
                            if (StatFs(context.filesDir.absolutePath).availableBytes < read + JOURNAL_EVERY_BYTES) throw DownloadFailed("INSUFFICIENT_STORAGE", "Needs more storage")
                            output.write(buf, 0, read); digest.update(buf, 0, read)
                        }
                        output.fd.sync()
                    }
                }
                if (flag.get()) throw DownloadFailed("ABORTED", "Import cancelled")
                val sha = digest.digest().joinToString("") { "%02x".format(it) }
                if (size == 0L || (expectedBytes != null && size != expectedBytes)) throw DownloadFailed("SIZE_MISMATCH", "Document size mismatch")
                if (expectedSha != null && sha != expectedSha.lowercase()) throw DownloadFailed("CHECKSUM_MISMATCH", "Document checksum mismatch")
                val ret = JSObject(); ret.put("actualHex", sha); ret.put("bytes", size); call.resolve(ret)
            } catch (e: DownloadFailed) {
                file.delete(); call.reject(e.message, e.code)
            } catch (_: Exception) {
                file.delete(); call.reject("Document could not be read", "BAD_URI")
            } finally { imports.remove(path, flag) }
        }, "findback-model-import").start()
    }

    /**
     * Declared byte size of a SAF document, or null when the provider does
     * not report one. Tries `OpenableColumns.SIZE` first, then the asset
     * file-descriptor length. Never throws; unknown means the streaming
     * path proceeds on headroom alone with its per-chunk storage checks.
     */
    private fun queryDocumentSize(uri: Uri): Long? {
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (index >= 0 && !cursor.isNull(index)) {
                        val value = cursor.getLong(index)
                        if (value > 0) return value
                    }
                }
            }
        } catch (_: Exception) { }
        try {
            context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { descriptor ->
                if (descriptor.length > 0) return descriptor.length
            }
        } catch (_: Exception) { }
        return null
    }

    @PluginMethod
    fun writeTextFile(call: PluginCall) {
        val path = call.getString("path") ?: ""
        val text = call.getString("text") ?: ""
        val file = File(path)
        if (!isUnderAppFiles(file) || text.length > MAX_TEXT_READ) { call.reject("Invalid metadata", "INVALID_REQUEST"); return }
        try {
            file.parentFile?.mkdirs()
            val tmp = File("$path.tmp")
            java.io.FileOutputStream(tmp).use { out -> out.write(text.toByteArray()); out.fd.sync() }
            if (!tmp.renameTo(file)) throw java.io.IOException()
            call.resolve()
        } catch (_: Exception) { call.reject("Metadata could not be saved", "WRITE_FAILED") }
    }

    @PluginMethod
    fun startDownload(call: PluginCall) {
        val url = call.getString("url")
        val stagingPath = call.getString("stagingPath")
        if (url.isNullOrBlank() || stagingPath.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val key = downloadKey(stagingPath)
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
        if (!isUnderAppFiles(task.stagingFile) || (task.journalPath != null && !isUnderAppFiles(File(task.journalPath)))) { call.reject("Invalid staging path", "INVALID_REQUEST"); return }
        if (active.putIfAbsent(key, task) != null) { call.reject("Download busy", "DOWNLOAD_BUSY"); return }
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
                    call.reject(e.message, e.code)
                } catch (_: javax.net.ssl.SSLException) {
                    call.reject("TLS verification failed", "TLS_ERROR")
                } catch (_: java.net.SocketTimeoutException) {
                    call.reject("Download timed out", "TIMEOUT")
                } catch (_: java.io.IOException) {
                    call.reject("Network transfer failed", if (task.cancelled.get()) "ABORTED" else "NETWORK_ERROR")
                } catch (e: Exception) {
                    call.reject("Download failed", "DOWNLOAD_FAILED")
                } finally {
                    active.remove(key, task)
                }
            },
            "findback-download",
        ).start()
    }

    /**
     * App-private model root (`filesDir/ai-models`, created). TS builds
     * `<root>/staging|models/<id>/<rev>/<file>` under it via
     * `buildModelPaths`, so both sides agree without string surgery.
     */
    @PluginMethod
    fun getRootDir(call: PluginCall) {
        try {
            val root = File(context.filesDir, "ai-models")
            root.mkdirs()
            val ret = JSObject()
            ret.put("rootDir", root.absolutePath)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("root_unavailable", e.message?.take(200))
        }
    }

    /** Small text read (journal sidecars only — never model bytes). */
    @PluginMethod
    fun readTextFile(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val file = File(path)
        if (!isUnderAppFiles(file) || !file.isFile) {
            val ret = JSObject()
            ret.put("exists", false)
            call.resolve(ret)
            return
        }
        try {
            if (file.length() > MAX_TEXT_READ) { call.reject("Metadata too large", "FILE_TOO_LARGE"); return }
            val text = file.readText(Charsets.UTF_8)
            if (text.length > MAX_TEXT_READ) {
                call.reject("file_too_large")
                return
            }
            val ret = JSObject()
            ret.put("exists", true)
            ret.put("text", text)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("read_failed", e.message?.take(200))
        }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val stagingPath = call.getString("stagingPath")
        if (stagingPath.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        imports[stagingPath]?.set(true)
        val task = active[downloadKey(stagingPath)]
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
                imports[path]?.set(true)
                active[downloadKey(path)]?.let { it.cancelled.set(true); it.connection?.disconnect() }
                if (file.isDirectory) file.deleteRecursively() else file.delete()
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
        if (!isUnderAppFiles(src) || !isUnderAppFiles(dst) || !src.exists()) {
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
            if (!DownloadPolicy.safeSource(url)) throw DownloadFailed("BAD_SOURCE", "Unsafe source URL")

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
                    if (!DownloadPolicy.publicDestination(current)) throw DownloadFailed("BAD_SOURCE", "Destination is not public")
                    val conn = (URL(current).openConnection() as HttpURLConnection).apply {
                        instanceFollowRedirects = false
                        connectTimeout = CONNECT_TIMEOUT_MS
                        readTimeout = READ_TIMEOUT_MS
                        setRequestProperty("User-Agent", USER_AGENT)
                        setRequestProperty("Accept-Encoding", "identity")
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
                        if (!DownloadPolicy.redirectAllowed(url, current)) throw DownloadFailed("BAD_SOURCE", "Redirect destination not allowed")
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
                    throw DownloadFailed("HTTP_$status", "download failed with HTTP $status")
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
                if (total != null && total != maxBytes) {
                    throw DownloadFailed(
                        "SIZE_MISMATCH",
                        "download size differs from exact expected bytes",
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
                throwIfCancelled()
                if (offset + received != maxBytes) throw DownloadFailed("SIZE_MISMATCH", "Truncated transfer")
                if (actualHex != expectedSha256.lowercase()) throw DownloadFailed("CHECKSUM_MISMATCH", "Checksum mismatch")
                return DownloadResult(received, total, actualHex, url)
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
        private const val MAX_TEXT_READ = 64 * 1024
        private val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)
    }
}
