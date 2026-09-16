package com.findback.app.vlm

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * SHA-256 utility for file hashing.
 */
object Sha256 {
    private const val BUFFER_SIZE = 64 * 1024 // 64 KiB

    /**
     * Computes the SHA-256 hash of a file as a lowercase hex string.
     */
    fun ofFile(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(BUFFER_SIZE)
        FileInputStream(file).use { input ->
            var bytesRead = input.read(buffer)
            while (bytesRead != -1) {
                digest.update(buffer, 0, bytesRead)
                bytesRead = input.read(buffer)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}