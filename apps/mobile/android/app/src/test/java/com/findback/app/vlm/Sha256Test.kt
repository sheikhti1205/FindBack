package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

class Sha256Test {
    @Test fun hashesAFileAsLowercaseHex() {
        val file = File.createTempFile("findback-sha", ".bin")
        try {
            file.writeBytes("findback".toByteArray())
            assertEquals(64, Sha256.ofFile(file).length)
            assertEquals(
                java.security.MessageDigest.getInstance("SHA-256").digest("findback".toByteArray())
                    .joinToString("") { "%02x".format(it) },
                Sha256.ofFile(file),
            )
        } finally { file.delete() }
    }
}