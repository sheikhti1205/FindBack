package com.findback.app.vlm

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlin.math.max
import kotlin.math.min

/**
 * Resumable model downloader with hash verification and retry logic.
 */
class ModelDownloader(
    private val context: Context,
    private val store: ModelStore
) {

    companion object {
        private const val MAX_RETRIES = 3
        private const val BASE_BACKOFF_MS = 1000L
        private const val BUFFER_SIZE = 64 * 1024 // 64 KiB
        private const val CONNECT_TIMEOUT_MS = 15000
        private const val READ_TIMEOUT_MS = 30000
    }

    /**
     * Downloads all files for a model manifest with progress reporting.
     * Returns the final VlmState after download and verification.
     */
    suspend fun download(
        manifest: ModelManifest,
        onProgress: (Long, Long) -> Unit
    ): VlmState {
        // Check storage before starting
        val totalExpectedBytes = manifest.files.sumOf { it.expectedBytes }
        val freeBytes = getFreeBytes()
        if (!ModelInstallPolicy.canInstall(freeBytes, totalExpectedBytes)) {
            return VlmState.INSUFFICIENT_STORAGE
        }

        for (spec in manifest.files) {
            val result = downloadFile(manifest, spec, onProgress)
            if (result != VlmState.INSTALLED_UNVERIFIED) {
                return result
            }
        }

        // All files downloaded and verified
        return VlmState.INSTALLED_UNVERIFIED
    }

    private suspend fun downloadFile(
        manifest: ModelManifest,
        spec: ModelFileSpec,
        onProgress: (Long, Long) -> Unit
    ): VlmState {
        val partFile = store.partFile(manifest, spec)
        val finalFile = store.finalFile(manifest, spec)
        val downloadUrl = buildDownloadUrl(manifest, spec)

        partFile.parentFile?.mkdirs()

        var partBytes = if (partFile.exists()) partFile.length() else 0L
        var retries = 0

        while (retries <= MAX_RETRIES) {
            try {
                val connection = openConnection(downloadUrl, partBytes)
                val responseCode = connection.responseCode

                when (responseCode) {
                    HttpURLConnection.HTTP_OK -> {
                        // Full download (200 OK) - server doesn't support range or fresh start
                        partBytes = 0
                        partFile.delete()
                    }
                    HttpURLConnection.HTTP_PARTIAL -> {
                        // Resume download (206 Partial Content)
                        val contentRange = connection.getHeaderField("Content-Range")
                        if (!validateContentRange(contentRange, partBytes, spec.expectedBytes)) {
                            // Invalid range response, restart
                            partBytes = 0
                            partFile.delete()
                            connection.disconnect()
                            continue
                        }
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

                if (expectedTotal != spec.expectedBytes) {
                    connection.disconnect()
                    throw DownloadException("Content length mismatch: expected ${spec.expectedBytes}, got $expectedTotal")
                }

                // Download with progress
                val inputStream = connection.inputStream
                val outputStream = FileOutputStream(partFile, partBytes > 0)

                val buffer = ByteArray(BUFFER_SIZE)
                var bytesRead = inputStream.read(buffer)
                var totalWritten = partBytes

                while (bytesRead != -1) {
                    outputStream.write(buffer, 0, bytesRead)
                    totalWritten += bytesRead
                    onProgress(totalWritten, spec.expectedBytes)
                    bytesRead = inputStream.read(buffer)
                }

                outputStream.close()
                inputStream.close()
                connection.disconnect()

                // Verify hash
                val actualHash = Sha256.ofFile(partFile)
                if (actualHash != spec.sha256) {
                    // Hash mismatch - delete corrupt file and retry
                    partFile.delete()
                    partBytes = 0L
                    retries++
                    if (retries <= MAX_RETRIES) {
                        Thread.sleep(calculateBackoff(retries))
                        continue
                    }
                    return VlmState.CORRUPT
                }

                // Hash matches - rename to final name
                if (!partFile.renameTo(finalFile)) {
                    throw DownloadException("Failed to rename part file to final name")
                }

                return VlmState.INSTALLED_UNVERIFIED

            } catch (e: Exception) {
                retries++
                if (retries <= MAX_RETRIES) {
                    Thread.sleep(calculateBackoff(retries))
                } else {
                    return VlmState.DOWNLOAD_FAILED
                }
            }
        }

        return VlmState.DOWNLOAD_FAILED
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

    private fun calculateBackoff(attempt: Int): Long {
        return BASE_BACKOFF_MS * (1L shl (attempt - 1)) // Exponential backoff: 1s, 2s, 4s
    }

    private fun getFreeBytes(): Long {
        val file = context.filesDir
        val stat = android.os.StatFs(file.path)
        return stat.availableBlocksLong * stat.blockSizeLong
    }

    private class DownloadException(message: String) : Exception(message)
}