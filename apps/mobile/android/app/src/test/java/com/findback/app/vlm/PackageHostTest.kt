package com.findback.app.vlm

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PackageHostTest {

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }
    }

    private data class FixtureFile(val path: String, val bytes: ByteArray, val method: Int = ZipEntry.DEFLATED)

    private fun manifestJson(entryId: String, files: List<FixtureFile>): String {
        val sb = StringBuilder()
        sb.append("{\"packageVersion\": \"1\", \"entryId\": \"$entryId\", ")
        sb.append("\"upstream\": {\"repo\": \"r\", \"rev\": \"v\", \"file\": \"f\"}, ")
        sb.append("\"createdAt\": \"2026-09-22T00:00:00Z\", \"files\": [")
        files.forEachIndexed { index, file ->
            sb.append("{\"path\": \"${file.path}\", \"bytes\": ${file.bytes.size}, ")
            sb.append("\"sha256\": \"${sha256Hex(file.bytes)}\", ")
            sb.append("\"method\": \"${if (file.method == ZipEntry.STORED) "STORE" else "DEFLATE"}\"}")
            if (index < files.size - 1) sb.append(", ")
        }
        sb.append("]}")
        return sb.toString()
    }

    private fun packageBytes(
        entryId: String,
        files: List<FixtureFile>,
        manifestOverride: String? = null,
        extraEntries: List<FixtureFile> = emptyList(),
        omitManifest: Boolean = false,
        manifestMethod: Int = ZipEntry.DEFLATED,
        contentOverride: Map<String, ByteArray> = emptyMap()
    ): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            if (!omitManifest) {
                val manifestBytes = (manifestOverride ?: manifestJson(entryId, files)).toByteArray(Charsets.UTF_8)
                zip.putNextEntry(ZipEntry(PackageHost.MANIFEST_NAME).apply { method = manifestMethod })
                zip.write(manifestBytes)
                zip.closeEntry()
            }
            for (file in files) {
                val content = contentOverride[file.path] ?: file.bytes
                val entry = ZipEntry(file.path).apply { method = file.method }
                if (file.method == ZipEntry.STORED) {
                    val crc = java.util.zip.CRC32()
                    crc.update(content)
                    entry.size = content.size.toLong()
                    entry.crc = crc.value
                }
                zip.putNextEntry(entry)
                zip.write(content)
                zip.closeEntry()
            }
            for (extra in extraEntries) {
                zip.putNextEntry(ZipEntry(extra.path))
                zip.write(extra.bytes)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun tempDirs(): Pair<File, File> {
        val root = Files.createTempDirectory("package-host-test").toFile()
        return File(root, "work").apply { mkdirs() } to File(root, "install").apply { mkdirs() }
    }

    private fun weightsBytes(size: Int = 256): ByteArray =
        ByteArray(size) { index -> (index * 31 % 251).toByte() }

    private fun tokenizerBytes(): ByteArray =
        "{\"vocab\": [\"hello\", \"world\"]}".toByteArray(Charsets.UTF_8)

    // Safe-path validation.

    @Test fun rejectsTraversalAbsoluteDriveLetterBackslashAndEmptySegments() {
        assertNotNull(PackageHost.findUnsafePathReason("../evil.bin"))
        assertNotNull(PackageHost.findUnsafePathReason("weights/../../evil.bin"))
        assertNotNull(PackageHost.findUnsafePathReason("/abs/path.bin"))
        assertNotNull(PackageHost.findUnsafePathReason("C:/win/path.bin"))
        assertNotNull(PackageHost.findUnsafePathReason("weights\\win.bin"))
        assertNotNull(PackageHost.findUnsafePathReason(""))
        assertNotNull(PackageHost.findUnsafePathReason("weights//dup.bin"))
        assertNull(PackageHost.findUnsafePathReason("weights/model.litertlm"))
        assertNull(PackageHost.findUnsafePathReason("tokenizer/vocab.json"))
        assertNull(PackageHost.findUnsafePathReason("manifest.json"))
    }

    @Test fun deniesExecutableSuffixesCaseInsensitively() {
        assertTrue(PackageHost.isDeniedSuffix("weights/evil.SO"))
        assertTrue(PackageHost.isDeniedSuffix("tools/run.sh"))
        assertTrue(PackageHost.isDeniedSuffix("lib/x.DLL"))
        assertFalse(PackageHost.isDeniedSuffix("weights/model.litertlm"))
        assertFalse(PackageHost.isDeniedSuffix("tokenizer/vocab.json"))
    }

    @Test fun sniffsElfMzDexAndMachOMagics() {
        assertTrue(PackageHost.hasDeniedMagic(byteArrayOf(0x7f, 0x45, 0x4c, 0x46), 4))
        assertTrue(PackageHost.hasDeniedMagic(byteArrayOf(0x4d, 0x5a, 0x00, 0x00), 4))
        assertTrue(PackageHost.hasDeniedMagic(byteArrayOf(0x64, 0x65, 0x78, 0x0a), 4))
        assertTrue(PackageHost.hasDeniedMagic(byteArrayOf(0xca.toByte(), 0xfe.toByte(), 0xba.toByte(), 0xbe.toByte()), 4))
        assertTrue(PackageHost.hasDeniedMagic(byteArrayOf(0xfe.toByte(), 0xed.toByte(), 0xfa.toByte(), 0xce.toByte()), 4))
        assertFalse(PackageHost.hasDeniedMagic(byteArrayOf(0x01, 0x02, 0x03), 3))
        assertFalse(PackageHost.hasDeniedMagic(tokenizerBytes(), tokenizerBytes().size))
    }

    // Import success + install layout.

    @Test fun importsValidPackageAndPromotesAtomically() {
        val (work, install) = tempDirs()
        val files = listOf(
            FixtureFile("weights/model.litertlm", weightsBytes(), ZipEntry.STORED),
            FixtureFile("tokenizer/vocab.json", tokenizerBytes())
        )
        val bytes = packageBytes("entry-a", files)
        val result = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "entry-a", sha256Hex(bytes), work, install
        )
        assertTrue(result.ok, result.reason)
        assertEquals("entry-a", result.manifest?.entryId)
        assertEquals(2, result.manifest?.files?.size)
        val installedWeights = File(install, "entry-a/weights/model.litertlm")
        val installedTokenizer = File(install, "entry-a/tokenizer/vocab.json")
        assertTrue(installedWeights.isFile)
        assertTrue(installedTokenizer.isFile)
        assertEquals(sha256Hex(weightsBytes()), sha256Hex(installedWeights.readBytes()))
        assertEquals(sha256Hex(tokenizerBytes()), sha256Hex(installedTokenizer.readBytes()))
        assertEquals(0, work.listFiles()?.size ?: 0)
    }

    @Test fun refusesUntrustedEntryIdTraversalBeforeCreatingAnInstallDirectory() {
        val (work, install) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val bytes = packageBytes("../escape", files)
        val result = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "../escape", sha256Hex(bytes), work, install
        )
        assertEquals(PackageHost.Code.ENTRY_MISMATCH, result.code)
        assertFalse(File(install.parentFile, "escape").exists())
    }

    @Test fun peekManifestReadsOnlyBoundedSchemaAndNeverTrustsAnUnsafeIdentity() {
        val (work, _) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val good = File(work, "good.fbmodel").apply { writeBytes(packageBytes("candidate-a", files)) }
        assertEquals("candidate-a", PackageHost.peekManifest(good)?.entryId)
        val bad = File(work, "bad.fbmodel").apply { writeBytes(packageBytes("../escape", files)) }
        assertNull(PackageHost.peekManifest(bad))
        assertNull(PackageHost.peekManifest(File(work, "missing.fbmodel")))
    }

    // Import rejections.

    @Test fun rejectsTraversalEntryConfinedToSandbox() {
        val (work, install) = tempDirs()
        val evil = FixtureFile("../evil.bin", byteArrayOf(1, 2, 3))
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        // Listed slip: manifest allow-list check fires first.
        val listed = packageBytes("entry-a", files + evil)
        val listedResult = PackageHost.importPackage(
            ByteArrayInputStream(listed), "entry-a", sha256Hex(listed), work, install
        )
        assertFalse(listedResult.ok)
        assertEquals(PackageHost.Code.UNSAFE_PATH, listedResult.code)
        // Unlisted slip: still rejected before anything installs.
        val unlisted = packageBytes("entry-a", files, extraEntries = listOf(evil))
        val unlistedResult = PackageHost.importPackage(
            ByteArrayInputStream(unlisted), "entry-a", sha256Hex(unlisted), work, install
        )
        assertFalse(unlistedResult.ok)
        assertEquals(PackageHost.Code.UNSAFE_PATH, unlistedResult.code)
        assertFalse(File(install, "entry-a").exists())
    }

    @Test fun rejectsAbsoluteEntry() {
        val (work, install) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val bytes = packageBytes("entry-a", files, extraEntries = listOf(FixtureFile("/abs.bin", byteArrayOf(9))))
        val result = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "entry-a", sha256Hex(bytes), work, install
        )
        assertFalse(result.ok)
        assertEquals(PackageHost.Code.UNSAFE_PATH, result.code)
    }

    @Test fun rejectsSymlinkBitEntry() {
        val (work, install) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val bytes = packageBytes("entry-a", files).withSymlinkBit("weights/model.litertlm")
        val result = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "entry-a", sha256Hex(bytes), work, install
        )
        assertFalse(result.ok)
        assertEquals(PackageHost.Code.UNSAFE_PATH, result.code)
        assertFalse(File(install, "entry-a").exists())
    }

    @Test fun rejectsDeniedSuffixAndExecutableMagic() {
        val (work, install) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val soBytes = packageBytes("entry-a", files + FixtureFile("weights/evil.so", byteArrayOf(1)))
        val soResult = PackageHost.importPackage(
            ByteArrayInputStream(soBytes), "entry-a", sha256Hex(soBytes), work, install
        )
        assertFalse(soResult.ok)
        assertEquals(PackageHost.Code.DENIED_FILE, soResult.code)

        val elf = byteArrayOf(0x7f, 0x45, 0x4c, 0x46, 0x01, 0x02)
        val elfFiles = listOf(
            FixtureFile("weights/model.litertlm", weightsBytes()),
            FixtureFile("tokenizer/vocab.json", elf)
        )
        val elfBytes = packageBytes("entry-a", elfFiles)
        val elfResult = PackageHost.importPackage(
            ByteArrayInputStream(elfBytes), "entry-a", sha256Hex(elfBytes), work, install
        )
        assertFalse(elfResult.ok)
        assertEquals(PackageHost.Code.DENIED_FILE, elfResult.code)
    }

    @Test fun rejectsUndeclaredAndMissingFiles() {
        val (work, install) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val extraBytes = packageBytes("entry-a", files, extraEntries = listOf(FixtureFile("stowaway.bin", byteArrayOf(7))))
        val extraResult = PackageHost.importPackage(
            ByteArrayInputStream(extraBytes), "entry-a", sha256Hex(extraBytes), work, install
        )
        assertFalse(extraResult.ok)
        assertEquals(PackageHost.Code.EXTRA_FILE, extraResult.code)

        val manifest = manifestJson(
            "entry-a",
            files + FixtureFile("tokenizer/vocab.json", tokenizerBytes())
        )
        val missingBytes = packageBytes("entry-a", files, manifestOverride = manifest)
        val missingResult = PackageHost.importPackage(
            ByteArrayInputStream(missingBytes), "entry-a", sha256Hex(missingBytes), work, install
        )
        assertFalse(missingResult.ok)
        assertEquals(PackageHost.Code.MISSING_FILE, missingResult.code)
    }

    @Test fun rejectsHashIdAndSizeMismatch() {
        val (work, install) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val bytes = packageBytes("entry-a", files)

        val tamperedContent = weightsBytes().copyOf().also { it[0] = (it[0].toInt() xor 0xFF).toByte() }
        val tamperedBytes = packageBytes(
            "entry-a", files,
            contentOverride = mapOf("weights/model.litertlm" to tamperedContent)
        )
        val tamperedResult = PackageHost.importPackage(
            ByteArrayInputStream(tamperedBytes), "entry-a", sha256Hex(tamperedBytes), work, install
        )
        assertFalse(tamperedResult.ok)
        assertEquals(PackageHost.Code.HASH_MISMATCH, tamperedResult.code)

        val wrongIdBytes = packageBytes("entry-other", files)
        val wrongIdResult = PackageHost.importPackage(
            ByteArrayInputStream(wrongIdBytes), "entry-a", sha256Hex(wrongIdBytes), work, install
        )
        assertFalse(wrongIdResult.ok)
        assertEquals(PackageHost.Code.ENTRY_MISMATCH, wrongIdResult.code)

        assertTrue(bytes.isNotEmpty())
        val wholeMismatch = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "entry-a", sha256Hex(byteArrayOf(0)), work, install
        )
        assertFalse(wholeMismatch.ok)
        assertEquals(PackageHost.Code.WHOLE_HASH_MISMATCH, wholeMismatch.code)

        val lyingManifest = manifestJson("entry-a", files).replace(
            "\"bytes\": ${weightsBytes().size}", "\"bytes\": ${weightsBytes().size + 1}"
        )
        val lyingBytes = packageBytes("entry-a", files, manifestOverride = lyingManifest)
        val lyingResult = PackageHost.importPackage(
            ByteArrayInputStream(lyingBytes), "entry-a", sha256Hex(lyingBytes), work, install
        )
        assertFalse(lyingResult.ok)
        assertEquals(PackageHost.Code.SIZE_MISMATCH, lyingResult.code)
    }

    @Test fun rejectsMissingPinManifestProblemsTruncationAndCorruption() {
        val (work, install) = tempDirs()
        val files = listOf(FixtureFile("weights/model.litertlm", weightsBytes()))
        val bytes = packageBytes("entry-a", files)

        val missingPin = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "entry-a", "", work, install
        )
        assertFalse(missingPin.ok)
        assertEquals(PackageHost.Code.MISSING_PIN, missingPin.code)

        val noManifest = packageBytes("entry-a", files, omitManifest = true)
        val noManifestResult = PackageHost.importPackage(
            ByteArrayInputStream(noManifest), "entry-a", sha256Hex(noManifest), work, install
        )
        assertFalse(noManifestResult.ok)
        assertEquals(PackageHost.Code.MANIFEST_MISSING, noManifestResult.code)

        val malformed = packageBytes("entry-a", files, manifestOverride = "{not json")
        val malformedResult = PackageHost.importPackage(
            ByteArrayInputStream(malformed), "entry-a", sha256Hex(malformed), work, install
        )
        assertFalse(malformedResult.ok)
        assertEquals(PackageHost.Code.MANIFEST_INVALID, malformedResult.code)

        val truncated = bytes.copyOf(bytes.size - 500)
        val truncatedResult = PackageHost.importPackage(
            ByteArrayInputStream(truncated), "entry-a", sha256Hex(truncated), work, install
        )
        assertFalse(truncatedResult.ok)
        assertEquals(PackageHost.Code.CORRUPT_ARCHIVE, truncatedResult.code)

        val corrupted = bytes.copyOf().withCorruptCentralDir()
        val corruptedResult = PackageHost.importPackage(
            ByteArrayInputStream(corrupted), "entry-a", sha256Hex(corrupted), work, install
        )
        assertFalse(corruptedResult.ok)
        assertEquals(PackageHost.Code.CORRUPT_ARCHIVE, corruptedResult.code)
    }

    @Test fun enforcesExpandedCapAndStorageBudget() {
        val (work, install) = tempDirs()
        val files = listOf(
            FixtureFile("weights/model.litertlm", weightsBytes(1024)),
            FixtureFile("tokenizer/vocab.json", tokenizerBytes())
        )
        val bytes = packageBytes("entry-a", files)

        val bombResult = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "entry-a", sha256Hex(bytes), work, install,
            maxExpandedBytes = 100
        )
        assertFalse(bombResult.ok)
        assertEquals(PackageHost.Code.PACKAGE_TOO_LARGE, bombResult.code)

        val storageResult = PackageHost.importPackage(
            ByteArrayInputStream(bytes), "entry-a", sha256Hex(bytes), work, install,
            freeBytes = 10
        )
        assertFalse(storageResult.ok)
        assertEquals(PackageHost.Code.INSUFFICIENT_STORAGE, storageResult.code)
        assertFalse(File(install, "entry-a").exists())
    }

    // Export.

    @Test fun exportsInstalledFilesAndRoundTripsThroughImport() {
        val (work, install) = tempDirs()
        val installDir = File(install, "entry-a").apply { mkdirs() }
        File(installDir, "weights").mkdirs()
        File(installDir, "tokenizer").mkdirs()
        File(installDir, "weights/model.litertlm").writeBytes(weightsBytes(1024))
        File(installDir, "tokenizer/vocab.json").writeBytes(tokenizerBytes())

        val exported = ByteArrayOutputStream()
        val exportResult = PackageHost.exportPackage("entry-a", installDir, exported)
        assertTrue(exportResult.ok, exportResult.reason)
        assertNotNull(exportResult.manifest)
        assertNotNull(exportResult.checksumsJson)
        val methods = exportResult.manifest.files.associate { it.path to it.method }
        assertEquals("STORE", methods["weights/model.litertlm"])
        assertEquals("DEFLATE", methods["tokenizer/vocab.json"])

        val reimport = PackageHost.importPackage(
            ByteArrayInputStream(exported.toByteArray()),
            "entry-a",
            sha256Hex(exported.toByteArray()),
            work,
            File(install, "reinstall-root").apply { mkdirs() }
        )
        // The exporter stamps empty upstream fields while the importer only
        // checks schema shape, entry id, and file pins — so this re-imports.
        assertTrue(reimport.ok, reimport.reason)
    }

    @Test fun trustedExportPackagesOnlyPinnedWeightsAndRejectsTamperedFiles() {
        val (work, install) = tempDirs()
        val weights = weightsBytes()
        val spec = ModelFileSpec("model.litertlm", weights.size.toLong(), sha256Hex(weights))
        val installed = File(install, "model.litertlm")
        installed.writeBytes(weights)
        File(install, "model.fbmodel").writeText("stale package cache")
        val out = ByteArrayOutputStream()
        val result = PackageHost.exportPackage("known-entry", install, out, trustedFiles = listOf(spec))
        assertTrue(result.ok, result.reason)
        assertEquals(listOf("weights/model.litertlm", "checksums.json"), result.manifest?.files?.map { it.path })
        val imported = PackageHost.importPackage(
            ByteArrayInputStream(out.toByteArray()), "known-entry", sha256Hex(out.toByteArray()), work,
            File(work.parentFile, "second-install")
        )
        assertTrue(imported.ok, imported.reason)
        installed.writeBytes("tampered".toByteArray())
        val refused = PackageHost.exportPackage("known-entry", install, ByteArrayOutputStream(), trustedFiles = listOf(spec))
        assertEquals(PackageHost.Code.HASH_MISMATCH, refused.code)
    }

    @Test fun refusesExportWithoutWeightsDeniedContentOrWriterFailure() {
        val (_, install) = tempDirs()
        val empty = File(install, "empty-entry").apply { mkdirs() }
        val emptyResult = PackageHost.exportPackage(
            "empty-entry", empty, ByteArrayOutputStream()
        )
        assertFalse(emptyResult.ok)
        assertEquals(PackageHost.Code.NO_FILES, emptyResult.code)

        val noWeights = File(install, "no-weights").apply { mkdirs() }
        File(noWeights, "tokenizer").mkdirs()
        File(noWeights, "tokenizer/vocab.json").writeBytes(tokenizerBytes())
        val noWeightsResult = PackageHost.exportPackage(
            "no-weights", noWeights, ByteArrayOutputStream()
        )
        assertFalse(noWeightsResult.ok)
        assertEquals(PackageHost.Code.MISSING_WEIGHTS, noWeightsResult.code)

        val withExe = File(install, "with-exe").apply { mkdirs() }
        File(withExe, "weights").mkdirs()
        File(withExe, "weights/model.litertlm").writeBytes(weightsBytes())
        File(withExe, "weights/evil.so").writeBytes(byteArrayOf(1))
        val exeResult = PackageHost.exportPackage(
            "with-exe", withExe, ByteArrayOutputStream()
        )
        assertFalse(exeResult.ok)
        assertEquals(PackageHost.Code.DENIED_FILE, exeResult.code)

        val good = File(install, "good-entry").apply { mkdirs() }
        File(good, "weights").mkdirs()
        File(good, "weights/model.litertlm").writeBytes(weightsBytes())
        val failing = object : OutputStream() {
            override fun write(b: Int): Unit = throw java.io.IOException("no space")
        }
        val failingResult = PackageHost.exportPackage("good-entry", good, failing)
        assertFalse(failingResult.ok)
        assertEquals(PackageHost.Code.CORRUPT_ARCHIVE, failingResult.code)
    }

    // Byte-surgery helpers for container-level fixtures.

    private fun readU16LE(data: ByteArray, offset: Int): Int =
        (data[offset].toInt() and 0xff) or ((data[offset + 1].toInt() and 0xff) shl 8)

    private fun readU32LE(data: ByteArray, offset: Int): Long =
        (data[offset].toLong() and 0xff) or
            ((data[offset + 1].toLong() and 0xff) shl 8) or
            ((data[offset + 2].toLong() and 0xff) shl 16) or
            ((data[offset + 3].toLong() and 0xff) shl 24)

    private fun writeU32LE(data: ByteArray, offset: Int, value: Long) {
        for (shift in 0..24 step 8) {
            data[offset + shift / 8] = ((value shr shift) and 0xff).toByte()
        }
    }

    private fun findEndOffset(data: ByteArray): Int {
        var i = data.size - 22
        while (i >= 0 && i >= data.size - 22 - 65535) {
            if (readU32LE(data, i) == 0x06054b50L) return i
            i--
        }
        error("END record not found in test fixture")
    }

    /** Sets the symlink file-type bits on one central-directory entry. */
    private fun ByteArray.withSymlinkBit(entryName: String): ByteArray {
        val end = findEndOffset(this)
        val centralOffset = readU32LE(this, end + 16).toInt()
        val centralCount = readU16LE(this, end + 10)
        var pos = centralOffset
        repeat(centralCount) {
            require(readU32LE(this, pos) == 0x02014b50L) { "bad central header in test fixture" }
            val nameLen = readU16LE(this, pos + 28)
            val name = copyOfRange(pos + 46, pos + 46 + nameLen).toString(Charsets.UTF_8)
            if (name == entryName) {
                writeU32LE(this, pos + 38, 0xA0000000L)
            }
            pos += 46 + nameLen + readU16LE(this, pos + 30) + readU16LE(this, pos + 32)
        }
        return this
    }

    /** Flips bytes inside the central directory to corrupt it. */
    private fun ByteArray.withCorruptCentralDir(): ByteArray {
        val end = findEndOffset(this)
        val centralOffset = readU32LE(this, end + 16).toInt()
        this[centralOffset + 10] = (this[centralOffset + 10].toInt() xor 0xFF).toByte()
        this[centralOffset + 11] = (this[centralOffset + 11].toInt() xor 0xFF).toByte()
        return this
    }
}
