package com.findback.app.update

import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

class AppUpdateTransferTest {
    private val bytes="synthetic APK bytes".toByteArray()
    private fun spec()=UpdateSpec("test-101","https://github.com/sheikhti1205/Norfold/releases/download/v1/a.apk",bytes.size.toLong(),
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString(""){"%02x".format(it)},"com.findback.app","beta","ab".repeat(32),setOf("arm64-v8a"),24,36,101,"1.0.1")
    @Test fun exactBoundedStreamIsSyncedAndReportsProgress() {
        val dir=Files.createTempDirectory("transfer").toFile()
        try {
            val file=java.io.File(dir,"update.apk");val progress=mutableListOf<Long>()
            val result=AppUpdateTransfer.copy(spec(),ByteArrayInputStream(bytes),file,{Long.MAX_VALUE},{false},{progress.add(it)})
            assertArrayEquals(bytes,file.readBytes()); assertEquals(spec().sha256,result)
            assertEquals(bytes.size.toLong(),progress.last())
        } finally {dir.deleteRecursively()}
    }
    @Test fun truncationHashMismatchOverflowDiskAndCancellationNeverProduceReadyBytes() {
        val dir=Files.createTempDirectory("transfer").toFile()
        try {
            val cases=listOf(spec() to bytes.dropLast(1).toByteArray(),spec().copy(sha256="00".repeat(32)) to bytes,
                spec() to (bytes+1.toByte()))
            for((s,data) in cases) {
                try {AppUpdateTransfer.copy(s,ByteArrayInputStream(data),java.io.File(dir,"update.apk"),{Long.MAX_VALUE},{false},{});fail("unsafe bytes accepted")}catch(_:UpdateRejected){}
            }
            try {AppUpdateTransfer.copy(spec(),ByteArrayInputStream(bytes),java.io.File(dir,"update.apk"),{0},{false},{});fail("disk gate bypass")}catch(_:UpdateRejected){}
            try {AppUpdateTransfer.copy(spec(),ByteArrayInputStream(bytes),java.io.File(dir,"update.apk"),{Long.MAX_VALUE},{true},{});fail("cancel bypass")}catch(_:UpdateRejected){}
        } finally {dir.deleteRecursively()}
    }
}
