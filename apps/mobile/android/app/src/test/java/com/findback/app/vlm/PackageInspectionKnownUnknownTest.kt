package com.findback.app.vlm

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * RED phase for the approved native task: known packages must inspect
 * without installing (exact whole + interior pins, never unknown
 * fallback), unknown requires exactly one `.litertlm`, and stale
 * sessions expire.
 */
class PackageInspectionKnownUnknownTest {

    private fun packageWithManifest(entryId: String, members: List<Pair<String, ByteArray>>): ByteArray {
        val filesJson = members.joinToString(",") { (path, bytes) ->
            """{"path":"$path","bytes":${bytes.size},"sha256":"${PackageHost.sha256Hex(bytes)}","method":"STORE"}"""
        }
        val json = """{"packageVersion":"1","entryId":"$entryId","upstream":{"repo":"fixture","rev":"v","file":"m"},"createdAt":"2026-09-23T00:00:00Z","files":[$filesJson]}"""
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write(json.toByteArray())
            zip.closeEntry()
            for ((path, bytes) in members) {
                val crc = CRC32().apply { update(bytes) }
                zip.putNextEntry(ZipEntry(path).apply {
                    method = ZipEntry.STORED; size = bytes.size.toLong(); this.crc = crc.value
                })
                zip.write(bytes)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    @Test
    fun unknownRequiresExactlyOneLitertlmMember() {
        val root = Files.createTempDirectory("inspect-unknown-").toFile()
        try {
            val store = PackageInspectionStore(root)
            val weights = "tiny weights".toByteArray()
            val two = packageWithManifest(
                "custom-model",
                listOf("weights/a.litertlm" to weights, "weights/b.litertlm" to weights)
            )
            assertNull(store.inspect(ByteArrayInputStream(two), freeBytes = 1024 * 1024))
            val zero = packageWithManifest("custom-model", listOf("weights/readme.txt" to weights))
            assertNull(store.inspect(ByteArrayInputStream(zero), freeBytes = 1024 * 1024))
            val one = packageWithManifest("custom-model", listOf("weights/model.litertlm" to weights))
            val ok = store.inspect(ByteArrayInputStream(one), freeBytes = 1024 * 1024)
            assertNotNull(ok)
            assertTrue(ok.unknown)
        } finally { root.deleteRecursively() }
    }

    @Test
    fun mismatchedKnownIdNeverFallsBackToUnknown() {
        val root = Files.createTempDirectory("inspect-known-").toFile()
        try {
            val store = PackageInspectionStore(root)
            val weights = "forged weights".toByteArray()
            val forged = packageWithManifest("smolvlm2-500m-litert-int4", listOf("weights/model.litertlm" to weights))
            val inspected = store.inspect(ByteArrayInputStream(forged), freeBytes = 1024 * 1024)
            assertNull(inspected, "mismatched known id must reject, never inspect as unknown")
            assertFalse(root.resolve("imported").exists())
        } finally { root.deleteRecursively() }
    }

    @Test
    fun staleSessionsExpireAndCleanStaging() {
        val root = Files.createTempDirectory("inspect-expiry-").toFile()
        try {
            val store = PackageInspectionStore(root)
            val weights = "tiny weights".toByteArray()
            val one = packageWithManifest("custom-model", listOf("weights/model.litertlm" to weights))
            val ok = store.inspect(ByteArrayInputStream(one), freeBytes = 1024 * 1024)!!
            assertNotNull(store.get(ok.id))
            store.pruneExpired(ok.createdAtMs + PackageInspectionStore.INSPECTION_TTL_MS + 1)
            assertNull(store.get(ok.id), "expired session must be gone")
            assertFalse(root.resolve("staging/${ok.id}").exists(), "expired staging must be cleaned")
        } finally { root.deleteRecursively() }
    }

    @Test
    fun knownProbeRoleGatingRequiresImageForVision() {
        assertEquals("INPUT_ERROR", InspectedProbeClassifier.validateRole("Vision", null))
        assertEquals("INPUT_ERROR", InspectedProbeClassifier.validateRole("Vision", "  "))
        assertNull(InspectedProbeClassifier.validateRole("Vision", "content://media/image/1"))
        assertNull(InspectedProbeClassifier.validateRole("Text", null))
        assertEquals("INPUT_ERROR", InspectedProbeClassifier.validateRole("Audio", null))
    }
}
