package com.findback.app.vlm

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PackageCommitterTest {

    private fun unknownFixture(id: String = "custom-model"): ByteArray {
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
    fun commitInspectedBindsStagedHashAndWritesProvenance() {
        val root = Files.createTempDirectory("model-commit-").toFile()
        try {
            val inspectionRoot = File(root, "inspection").apply { mkdirs() }
            val store = ModelStore(File(root, "library"))
            val inspected = PackageInspectionStore(inspectionRoot)
                .inspect(unknownFixture().inputStream(), freeBytes = 1024 * 1024)!!
            val result = PackageCommitter.commitInspected(inspected, store)
            assertTrue(result.ok, result.reason)
            val namespaced = inspected.packageSha256.lowercase()
            val installed = File(store.root, "imported/$namespaced/weights/model.litertlm")
            assertTrue(installed.isFile)
            val provenance = File(store.root, "imported/$namespaced/provenance.json")
            assertTrue(provenance.isFile)
            assertTrue(provenance.readText().contains(inspected.packageSha256))
            assertFalse(File(store.root, "imported/custom-model").exists(), "manifest id must never be the install identity")
        } finally { root.deleteRecursively() }
    }

    @Test
    fun commitInspectedRefusesChangedStagingFile() {
        val root = Files.createTempDirectory("model-commit-").toFile()
        try {
            val inspectionRoot = File(root, "inspection").apply { mkdirs() }
            val store = ModelStore(File(root, "library"))
            val inspected = PackageInspectionStore(inspectionRoot)
                .inspect(unknownFixture().inputStream(), freeBytes = 1024 * 1024)!!
            inspected.packageFile.appendBytes("tampered after inspection".toByteArray())
            val result = PackageCommitter.commitInspected(inspected, store)
            assertFalse(result.ok)
            assertFalse(File(store.root, "imported").exists())
        } finally { root.deleteRecursively() }
    }

    @Test
    fun commitInspectedReconcilesOccupiedTargetAndStillRefusesKnownIds() {
        val root = Files.createTempDirectory("model-commit-").toFile()
        try {
            val inspectionRoot = File(root, "inspection").apply { mkdirs() }
            val store = ModelStore(File(root, "library"))
            val store2 = PackageInspectionStore(inspectionRoot)
            val first = store2.inspect(unknownFixture().inputStream(), freeBytes = 1024 * 1024)!!
            assertTrue(PackageCommitter.commitInspected(first, store).ok)
            // Retry after an interruption reconciles the intact occupant
            // (same package SHA namespace) instead of a dead-end refusal.
            val second = store2.inspect(unknownFixture().inputStream(), freeBytes = 1024 * 1024)!!
            assertTrue(PackageCommitter.commitInspected(second, store).ok)

            val forged = PackageInspectionStore.InspectedPackage(
                id = UUID.randomUUID().toString(),
                manifest = PackageHost.Manifest(
                    packageVersion = "1",
                    entryId = "smolvlm2-500m-litert-int4",
                    upstreamRepo = "fixture", upstreamRev = "v", upstreamFile = "m",
                    createdAt = "2026-09-23T00:00:00Z", files = emptyList()
                ),
                packageSha256 = PackageHost.sha256Hex("x".toByteArray()),
                unknown = false,
                sandbox = File(root, "empty-sandbox").apply { mkdirs() },
                packageFile = File(root, "x.bin").apply { writeBytes("x".toByteArray()) }
            )
            assertFalse(PackageCommitter.commitInspected(forged, store).ok)
        } finally { root.deleteRecursively() }
    }
}
