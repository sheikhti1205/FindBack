package com.findback.app.vlm

import android.content.Context
import kotlinx.coroutines.delay
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException

/**
 * Resumable, repairable model downloader with hash verification and retry.
 *
 * Chunk path (when trusted chunk hashes exist): for each missing chunk,
 * HTTP Range exact range -> require 206 + Content-Range -> stream into
 * `.chunk.tmp` -> enforce exact byte count -> SHA-256 temp -> compare trusted
 * hash -> only if valid, write at exact offset in `.part`, flush, atomically
 * update journal -> delete chunk temp. Never overwrites a verified range with
 * unverified bytes. Sequential (one chunk at a time).
 *
 * Resume: journal validated (revision/size); journal missing/corrupt but
 * `.part` exists -> rebuild by re-hashing, never delete.
 *
 * Whole-file: VERIFYING_FILE -> whole SHA -> install, or REPAIR_NEEDED ->
 * REPAIRING (bad chunks only), or MANIFEST_MISMATCH (all chunks pass yet
 * whole fails: stop, preserve evidence, no loop, no deletion).
 *
 * Retry: bounded exponential backoff + jitter + Retry-After for 408/425/429/
 * 5xx without resetting verified chunks; budget exhausted -> PAUSED_ERROR
 * with partials preserved. Pause preserves verified chunks. Cancel keeps or
 * removes the partial per caller choice. Disk-full -> INSUFFICIENT_STORAGE
 * preserving partials.
 */
class ModelDownloader(
    private val context: Context,
    private val store: ModelStore
) {

    companion object {
        private const val BUFFER_SIZE = 64 * 1024 // 64 KiB
        private const val CONNECT_TIMEOUT_MS = 15000
        private const val READ_TIMEOUT_MS = 30000
        private const val MAX_REPAIR_ROUNDS = 2
    }

    @Volatile private var pauseRequested = false
    @Volatile private var cancelRequested = false
    @Volatile private var cancelRemovePartial = false

    fun requestPause() {
        pauseRequested = true
    }

    fun requestCancel(removePartial: Boolean) {
        cancelRequested = true
        cancelRemovePartial = removePartial
    }

    fun resetControl() {
        pauseRequested = false
        cancelRequested = false
        cancelRemovePartial = false
    }

    /**
     * Downloads all files for a model manifest with progress reporting.
     * Returns the final VlmState after download and verification.
     */
    suspend fun download(
        manifest: ModelManifest,
        onProgress: (Long, Long) -> Unit,
        onState: (VlmState) -> Unit = {}
    ): VlmState {
        resetControl()
        // Check storage before starting (full bytes + one chunk temp + headroom;
        // no 2x requirement since install is an atomic rename).
        val totalExpectedBytes = manifest.files.sumOf { it.expectedBytes }
        val freeBytes = getFreeBytes()
        if (!ModelInstallPolicy.canInstall(freeBytes, totalExpectedBytes)) {
            return VlmState.INSUFFICIENT_STORAGE
        }

        for (spec in manifest.files) {
            val result = downloadFile(manifest, spec, onProgress, onState)
            if (result != VlmState.INSTALLED_UNVERIFIED) {
                return result
            }
        }

        return VlmState.INSTALLED_UNVERIFIED
    }

    private suspend fun downloadFile(
        manifest: ModelManifest,
        spec: ModelFileSpec,
        onProgress: (Long, Long) -> Unit,
        onState: (VlmState) -> Unit
    ): VlmState {
        val partFile = store.partFile(manifest, spec)
        val finalFile = store.finalFile(manifest, spec)
        val journalFile = store.journalFile(manifest, spec)
        val chunkTmp = store.chunkTmpFile(manifest, spec)
        val downloadUrl = buildDownloadUrl(manifest, spec)
        partFile.parentFile?.mkdirs()

        if (finalFile.exists() && finalFile.length() == spec.expectedBytes &&
            Sha256.ofFile(finalFile) == spec.sha256
        ) {
            return VlmState.INSTALLED_UNVERIFIED
        }

        val trusted = ChunkManifest.chunksFor(spec)

        // Load or rebuild the journal; never delete the part file here.
        var journal = TransferJournalStore.load(journalFile)
        if (journal != null && (journal.revision != manifest.revision || journal.expectedBytes != spec.expectedBytes)) {
            journal = null
        }
        if (journal == null && partFile.exists()) {
            journal = TransferJournalStore.rebuildByRehashing(
                revision = manifest.revision,
                expectedBytes = spec.expectedBytes,
                chunkSize = ChunkManifest.DEFAULT_CHUNK_SIZE,
                sourceUrl = downloadUrl,
                partFile = partFile,
                trusted = trusted
            )
        }

        return try {
            val result = if (trusted.isNotEmpty()) {
                downloadChunked(manifest, spec, trusted, journal, downloadUrl, onProgress, onState)
            } else {
                downloadLegacy(manifest, spec, journal, downloadUrl, onProgress, onState)
            }
            if (result == VlmState.INSTALLED_UNVERIFIED) {
                if (!partFile.renameTo(finalFile)) {
                    throw DownloadException("Failed to rename part file to final name")
                }
                journalFile.delete()
                chunkTmp.delete()
            }
            result
        } catch (e: PauseRequested) {
            VlmState.PAUSED
        } catch (e: CancelRequested) {
            if (e.removePartial) {
                partFile.delete()
                journalFile.delete()
                chunkTmp.delete()
                VlmState.NOT_INSTALLED
            } else {
                VlmState.PAUSED
            }
        } catch (e: InsufficientStorage) {
            VlmState.INSUFFICIENT_STORAGE
        }
    }

    // ---- Chunked path (trusted chunk hashes available) ----

    private suspend fun downloadChunked(
        manifest: ModelManifest,
        spec: ModelFileSpec,
        trusted: List<ChunkSpec>,
        journal: TransferJournal?,
        downloadUrl: String,
        onProgress: (Long, Long) -> Unit,
        onState: (VlmState) -> Unit
    ): VlmState {
        val partFile = store.partFile(manifest, spec)
        val journalFile = store.journalFile(manifest, spec)
        val chunkTmp = store.chunkTmpFile(manifest, spec)
        var verified = journal?.verifiedChunks?.toMutableSet() ?: mutableSetOf()
        var retries = journal?.retries ?: 0
        var etag = journal?.etag
        var lastModified = journal?.lastModified

        ensurePartSize(partFile, spec.expectedBytes)

        var attempt = 0
        val pending = trusted.filter { it.index !in verified }.map { it.index }.toMutableList()
        onState(VlmState.DOWNLOADING)
        while (pending.isNotEmpty()) {
            checkControl()
            val chunk = trusted[pending.first()]
            try {
                onState(VlmState.DOWNLOADING)
                val (chunkEtag, chunkLastModified) = fetchChunk(
                    spec = chunk,
                    expectedBytes = spec.expectedBytes,
                    url = downloadUrl,
                    tmpFile = chunkTmp,
                    verifiedBytesBase = verifiedBytes(trusted, verified),
                    onProgress = onProgress
                )
                if (etag == null) etag = chunkEtag
                if (lastModified == null) lastModified = chunkLastModified
                // Temp chunk validated (206 + length + trusted hash): commit at offset.
                onState(VlmState.VERIFYING_CHUNK)
                commitChunkAtOffset(partFile, chunkTmp, chunk)
                verified.add(chunk.index)
                pending.removeAt(0)
                attempt = 0
                persistJournal(
                    journalFile, manifest, spec, verified, downloadUrl,
                    etag, lastModified, retries
                )
            } catch (e: ChunkBadContentRange) {
                throw DownloadException("Invalid Content-Range for chunk ${chunk.index}")
            } catch (e: ChunkHashMismatch) {
                // Corrupt chunk bytes from network: temp discarded, verified set kept.
                chunkTmp.delete()
                attempt++
                if (TransferRetryPolicy.budgetExhausted(attempt)) return VlmState.PAUSED_ERROR
                delay(TransferRetryPolicy.backoffMs(attempt))
            } catch (e: HttpRetryable) {
                attempt++
                if (TransferRetryPolicy.budgetExhausted(attempt)) return VlmState.PAUSED_ERROR
                delay(TransferRetryPolicy.backoffMs(attempt, retryAfterMs = e.retryAfterMs))
            } catch (e: PauseRequested) {
                throw e
            } catch (e: CancelRequested) {
                throw e
            } catch (e: InsufficientStorage) {
                throw e
            } catch (e: IOException) {
                if (isNoSpace(e)) throw InsufficientStorage()
                attempt++
                if (TransferRetryPolicy.budgetExhausted(attempt)) return VlmState.PAUSED_ERROR
                delay(TransferRetryPolicy.backoffMs(attempt))
            }
        }

        // All chunks verified per-chunk: whole-file verification + repair.
        repeat(MAX_REPAIR_ROUNDS + 1) {
            checkControl()
            onState(VlmState.VERIFYING_FILE)
            if (Sha256.ofFile(partFile) == spec.sha256) {
                return VlmState.INSTALLED_UNVERIFIED
            }
            val bad = ChunkTransferEngine.scanBadChunks(partFile, trusted)
            if (bad.isEmpty()) {
                // All chunk hashes pass yet whole SHA fails: manifest mismatch.
                // Stop the automatic loop, preserve evidence, no deletion.
                onState(VlmState.MANIFEST_MISMATCH)
                return VlmState.MANIFEST_MISMATCH
            }
            onState(VlmState.REPAIR_NEEDED)
            onState(VlmState.REPAIRING)
            verified.removeAll(bad.toSet())
            for (index in bad) {
                checkControl()
                val chunk = trusted[index]
                var chunkAttempt = 0
                while (true) {
                    checkControl()
                    try {
                        fetchChunk(
                            spec = chunk,
                            expectedBytes = spec.expectedBytes,
                            url = downloadUrl,
                            tmpFile = chunkTmp,
                            verifiedBytesBase = verifiedBytes(trusted, verified),
                            onProgress = onProgress
                        )
                        commitChunkAtOffset(partFile, chunkTmp, chunk)
                        verified.add(index)
                        persistJournal(
                            journalFile, manifest, spec, verified, downloadUrl,
                            etag, lastModified, retries
                        )
                        break
                    } catch (e: HttpRetryable) {
                        chunkAttempt++
                        if (TransferRetryPolicy.budgetExhausted(chunkAttempt)) return VlmState.PAUSED_ERROR
                        delay(TransferRetryPolicy.backoffMs(chunkAttempt, retryAfterMs = e.retryAfterMs))
                    } catch (e: ChunkHashMismatch) {
                        chunkTmp.delete()
                        chunkAttempt++
                        if (TransferRetryPolicy.budgetExhausted(chunkAttempt)) return VlmState.PAUSED_ERROR
                        delay(TransferRetryPolicy.backoffMs(chunkAttempt))
                    }
                }
            }
        }
        // Repair rounds exhausted with whole hash still failing.
        val bad = ChunkTransferEngine.scanBadChunks(partFile, trusted)
        return ChunkTransferEngine.decideAfterWholeHash(
            allChunksVerified = bad.isEmpty(),
            wholeHashMatches = false
        )
    }

    private fun verifiedBytes(trusted: List<ChunkSpec>, verified: Set<Int>): Long {
        return trusted.filter { it.index in verified }.sumOf { it.length }
    }

    private fun ensurePartSize(partFile: File, expectedBytes: Long) {
        if (!partFile.exists()) {
            RandomAccessFile(partFile, "rw").use { it.setLength(expectedBytes) }
        } else if (partFile.length() != expectedBytes) {
            RandomAccessFile(partFile, "rw").use { it.setLength(expectedBytes) }
        }
    }

    private data class FetchHeaders(val etag: String?, val lastModified: String?)

    /**
     * Fetches one exact chunk range into [tmpFile] after validating 206 +
     * Content-Range + exact length + trusted hash. Returns response headers.
     */
    private fun fetchChunk(
        spec: ChunkSpec,
        expectedBytes: Long,
        url: String,
        tmpFile: File,
        verifiedBytesBase: Long,
        onProgress: (Long, Long) -> Unit
    ): FetchHeaders {
        checkControl()
        val connection = openChunkConnection(url, spec)
        try {
            val code = connection.responseCode
            if (TransferRetryPolicy.isRetryable(code)) {
                throw HttpRetryable(TransferRetryPolicy.parseRetryAfter(connection.getHeaderField("Retry-After")))
            }
            if (code != HttpURLConnection.HTTP_PARTIAL) {
                throw ChunkBadContentRange()
            }
            val body = readBody(connection, spec.length)
            val validation = ChunkTransferEngine.validateChunkResponse(
                spec = spec,
                expectedBytes = expectedBytes,
                response = ChunkHttpResponse(code, connection.getHeaderField("Content-Range"), body)
            )
            if (validation != ChunkValidation.Ok) throw ChunkBadContentRange()
            tmpFile.parentFile?.mkdirs()
            tmpFile.writeBytes(body)
            if (!ChunkTransferEngine.chunkBytesMatch(tmpFile.readBytes(), spec)) {
                throw ChunkHashMismatch()
            }
            onProgress(verifiedBytesBase + spec.length, expectedBytes)
            return FetchHeaders(connection.getHeaderField("ETag"), connection.getHeaderField("Last-Modified"))
        } finally {
            connection.disconnect()
        }
    }

    private fun commitChunkAtOffset(partFile: File, tmpFile: File, chunk: ChunkSpec) {
        checkControl()
        RandomAccessFile(partFile, "rw").use { raf ->
            raf.seek(chunk.offset)
            raf.write(tmpFile.readBytes())
            raf.fd.sync()
        }
        tmpFile.delete()
    }

    private fun persistJournal(
        journalFile: File,
        manifest: ModelManifest,
        spec: ModelFileSpec,
        verified: Set<Int>,
        sourceUrl: String,
        etag: String?,
        lastModified: String?,
        retries: Int
    ) {
        TransferJournalStore.saveAtomic(
            journalFile,
            TransferJournal(
                revision = manifest.revision,
                expectedBytes = spec.expectedBytes,
                chunkSize = ChunkManifest.DEFAULT_CHUNK_SIZE,
                verifiedChunks = verified.toSet(),
                sourceUrl = sourceUrl,
                etag = etag,
                lastModified = lastModified,
                retries = retries,
                updatedAtMs = System.currentTimeMillis()
            )
        )
    }

    private fun openChunkConnection(urlString: String, chunk: ChunkSpec): HttpURLConnection {
        val connection = URL(urlString).openConnection() as HttpURLConnection
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        connection.requestMethod = "GET"
        connection.setRequestProperty("Range", "bytes=${chunk.offset}-${chunk.offset + chunk.length - 1}")
        return connection
    }

    // ---- Legacy whole-file path (no trusted chunk manifest) ----

    private suspend fun downloadLegacy(
        manifest: ModelManifest,
        spec: ModelFileSpec,
        journal: TransferJournal?,
        downloadUrl: String,
        onProgress: (Long, Long) -> Unit,
        onState: (VlmState) -> Unit
    ): VlmState {
        val partFile = store.partFile(manifest, spec)
        partFile.parentFile?.mkdirs()

        var partBytes = if (partFile.exists()) partFile.length() else 0L
        if (partBytes > spec.expectedBytes) {
            // Stale oversized part: shrink, never treat as installed.
            RandomAccessFile(partFile, "rw").use { it.setLength(spec.expectedBytes) }
            partBytes = spec.expectedBytes
        }
        var attempt = 0
        var restarts = 0
        onState(VlmState.DOWNLOADING)

        while (!TransferRetryPolicy.budgetExhausted(attempt, maxAttempts = 3)) {
            checkControl()
            try {
                val connection = openConnection(downloadUrl, partBytes)
                val responseCode = connection.responseCode

                if (TransferRetryPolicy.isRetryable(responseCode)) {
                    val retryAfter = TransferRetryPolicy.parseRetryAfter(connection.getHeaderField("Retry-After"))
                    connection.disconnect()
                    attempt++
                    if (TransferRetryPolicy.budgetExhausted(attempt, maxAttempts = 3)) {
                        return VlmState.PAUSED_ERROR
                    }
                    delay(TransferRetryPolicy.backoffMs(attempt, retryAfterMs = retryAfter))
                    continue
                }

                when (responseCode) {
                    HttpURLConnection.HTTP_OK -> {
                        // Full download (200 OK): server ignored Range or fresh start.
                        if (partBytes > 0 && restarts == 0) {
                            partBytes = 0
                            partFile.delete()
                            restarts++
                        } else if (partBytes > 0) {
                            connection.disconnect()
                            throw DownloadException("Server does not support Range requests")
                        }
                    }
                    HttpURLConnection.HTTP_PARTIAL -> {
                        val contentRange = connection.getHeaderField("Content-Range")
                        if (!validateContentRange(contentRange, partBytes, spec.expectedBytes)) {
                            connection.disconnect()
                            throw DownloadException("Invalid Content-Range: $contentRange")
                        }
                    }
                    416 -> {
                        connection.disconnect()
                        // Range unsatisfiable: part may already be complete -> verify below.
                        if (partFile.exists() && partFile.length() == spec.expectedBytes) {
                            break
                        }
                        partBytes = 0
                        partFile.delete()
                        restarts++
                        if (restarts > 1) throw DownloadException("Repeated 416 responses")
                        continue
                    }
                    401, 403, 404 -> {
                        connection.disconnect()
                        throw DownloadException("Permanent HTTP $responseCode for pinned source")
                    }
                    else -> {
                        connection.disconnect()
                        throw DownloadException("Unexpected response code: $responseCode")
                    }
                }

                val contentLength = connection.contentLengthLong
                val expectedTotal = if (responseCode == HttpURLConnection.HTTP_PARTIAL) {
                    partBytes + contentLength
                } else {
                    contentLength
                }

                if (expectedTotal != spec.expectedBytes && !(responseCode == 416)) {
                    connection.disconnect()
                    throw DownloadException(
                        "Content length mismatch: expected ${spec.expectedBytes}, got $expectedTotal"
                    )
                }

                val inputStream = connection.inputStream
                val outputStream = FileOutputStream(partFile, partBytes > 0)

                try {
                    val buffer = ByteArray(BUFFER_SIZE)
                    var bytesRead = inputStream.read(buffer)
                    var totalWritten = partBytes

                    while (bytesRead != -1) {
                        checkControl()
                        outputStream.write(buffer, 0, bytesRead)
                        totalWritten += bytesRead
                        onProgress(totalWritten, spec.expectedBytes)
                        bytesRead = inputStream.read(buffer)
                    }
                    outputStream.fd.sync()
                } catch (e: IOException) {
                    try { outputStream.close() } catch (ignored: Exception) { }
                    try { inputStream.close() } catch (ignored: Exception) { }
                    connection.disconnect()
                    if (isNoSpace(e)) throw InsufficientStorage()
                    throw e
                }
                outputStream.close()
                inputStream.close()
                connection.disconnect()

                break
            } catch (e: PauseRequested) {
                throw e
            } catch (e: CancelRequested) {
                throw e
            } catch (e: InsufficientStorage) {
                throw e
            } catch (e: DownloadException) {
                // Permanent/actionable: no retry loop.
                return VlmState.DOWNLOAD_FAILED
            } catch (e: SocketTimeoutException) {
                attempt++
                if (TransferRetryPolicy.budgetExhausted(attempt, maxAttempts = 3)) {
                    return VlmState.PAUSED_ERROR
                }
                delay(TransferRetryPolicy.backoffMs(attempt))
                partBytes = if (partFile.exists()) partFile.length() else 0L
            } catch (e: UnknownHostException) {
                attempt++
                if (TransferRetryPolicy.budgetExhausted(attempt, maxAttempts = 3)) {
                    return VlmState.PAUSED_ERROR
                }
                delay(TransferRetryPolicy.backoffMs(attempt))
                partBytes = if (partFile.exists()) partFile.length() else 0L
            } catch (e: IOException) {
                if (isNoSpace(e)) throw InsufficientStorage()
                attempt++
                if (TransferRetryPolicy.budgetExhausted(attempt, maxAttempts = 3)) {
                    return VlmState.PAUSED_ERROR
                }
                delay(TransferRetryPolicy.backoffMs(attempt))
                partBytes = if (partFile.exists()) partFile.length() else 0L
            }
        }

        if (TransferRetryPolicy.budgetExhausted(attempt, maxAttempts = 3)) {
            return VlmState.PAUSED_ERROR
        }

        // Whole-file verification. Legacy path has no chunk hashes, so a
        // mismatch cannot be range-repaired: preserve the part for a future
        // chunk-manifest repair instead of deleting verified-adjacent bytes.
        checkControl()
        onState(VlmState.VERIFYING_FILE)
        onState(VlmState.VERIFYING_HASH)
        return if (Sha256.ofFile(partFile) == spec.sha256) {
            VlmState.INSTALLED_UNVERIFIED
        } else {
            VlmState.CORRUPT
        }
    }

    private fun readBody(connection: HttpURLConnection, exactLength: Long): ByteArray {
        try {
            connection.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(BUFFER_SIZE)
                var total = 0L
                while (true) {
                    checkControl()
                    val n = input.read(buffer)
                    if (n == -1) break
                    out.write(buffer, 0, n)
                    total += n
                    if (total > exactLength) break
                }
                return out.toByteArray()
            }
        } catch (e: IOException) {
            if (isNoSpace(e)) throw InsufficientStorage()
            throw e
        }
    }

    private fun checkControl() {
        if (cancelRequested) throw CancelRequested(cancelRemovePartial)
        if (pauseRequested) throw PauseRequested()
    }

    private fun buildDownloadUrl(manifest: ModelManifest, spec: ModelFileSpec): String {
        return "https://huggingface.co/${manifest.sourceRepo}/resolve/${manifest.revision}/${spec.path}"
    }

    private fun openConnection(urlString: String, partBytes: Long): HttpURLConnection {
        val url = URL(urlString)
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        connection.requestMethod = "GET"
        if (partBytes > 0) {
            connection.setRequestProperty("Range", "bytes=$partBytes-")
        }
        return connection
    }

    private fun validateContentRange(contentRange: String?, partBytes: Long, expectedBytes: Long): Boolean {
        // Content-Range: bytes <start>-<end>/<total>
        return contentRange?.let { range ->
            val parts = range.split(" ")
            if (parts.size != 2) return@let false
            val rangePart = parts[1]
            val rangeParts = rangePart.split("/")
            if (rangeParts.size != 2) return@let false
            val total = rangeParts[1].toLongOrNull() ?: return@let false
            val startEnd = rangeParts[0].split("-")
            if (startEnd.size != 2) return@let false
            val start = startEnd[0].toLongOrNull() ?: return@let false
            val end = startEnd[1].toLongOrNull() ?: return@let false
            total == expectedBytes && start == partBytes && end == expectedBytes - 1
        } ?: false
    }

    private fun isNoSpace(e: IOException): Boolean {
        val message = e.message?.lowercase() ?: return false
        return message.contains("no space") || message.contains("enospc") || message.contains("not enough space")
    }

    private fun getFreeBytes(): Long {
        val file = context.filesDir
        val stat = android.os.StatFs(file.path)
        return stat.availableBlocksLong * stat.blockSizeLong
    }

    internal class DownloadException(message: String) : Exception(message)
    private class HttpRetryable(val retryAfterMs: Long?) : Exception()
    private class ChunkBadContentRange : Exception()
    private class ChunkHashMismatch : Exception()
    private class PauseRequested : Exception()
    private class CancelRequested(val removePartial: Boolean) : Exception()
    private class InsufficientStorage : Exception()
}
