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
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PackageInspectionStoreTest {
    private fun fixture(id: String = "custom-model"): ByteArray {
        val weights = "small data-only LiteRT fixture".toByteArray()
        val hash = PackageHost.sha256Hex(weights)
        val json = """{"packageVersion":"1","entryId":"$id","upstream":{"repo":"fixture","rev":"v","file":"model.litertlm"},"createdAt":"2026-09-23T00:00:00Z","files":[{"path":"weights/model.litertlm","bytes":${weights.size},"sha256":"$hash","method":"STORE"}]}"""
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write(json.toByteArray())
            zip.closeEntry()
            val crc = CRC32().apply { update(weights) }
            zip.putNextEntry(ZipEntry("weights/model.litertlm").apply {
                method = ZipEntry.STORED; size = weights.size.toLong(); this.crc = crc.value
            })
            zip.write(weights)
            zip.closeEntry()
        }
        return out.toByteArray()
    }

    @Test
    fun inspectionValidatesDataWithoutInstallingAndNamesStagesByRandomId() {
        val root = Files.createTempDirectory("model-inspection-").toFile()
        try {
            val store = PackageInspectionStore(root)
            val bytes = fixture()
            val one = store.inspect(ByteArrayInputStream(bytes), freeBytes = 1024 * 1024)
            val two = store.inspect(ByteArrayInputStream(bytes), freeBytes = 1024 * 1024)
            assertNotNull(one)
            assertNotNull(two)
            assertNotEquals(one.id, two.id)
            assertEquals("custom-model", one.manifest.entryId)
            assertEquals(PackageHost.sha256Hex(bytes), one.packageSha256)
            assertTrue(one.unknown)
            assertTrue(one.sandbox.isDirectory)
            assertFalse(root.resolve("imported").exists(), "inspection never installs a library entry")
            store.discard(one.id)
            assertNull(store.get(one.id))
            assertTrue(store.get(two.id) != null)
        } finally { root.deleteRecursively() }
    }

    @Test
    fun forgedKnownCatalogueIdCannotEnterUnknownImportFlow() {
        val root = Files.createTempDirectory("model-inspection-").toFile()
        try {
            val inspected = PackageInspectionStore(root).inspect(
                ByteArrayInputStream(fixture("smolvlm2-500m-litert-int4")), freeBytes = 1024 * 1024
            )
            assertNull(inspected, "known id with wrong installed weights must be rejected, not renamed as custom")
        } finally { root.deleteRecursively() }
    }
}
