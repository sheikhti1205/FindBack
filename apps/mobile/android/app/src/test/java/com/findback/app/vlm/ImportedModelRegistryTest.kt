package com.findback.app.vlm

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Imported registry: persistent app-private list keyed by full package
 * SHA-256, delete removes exactly one entry, export re-hashes installed
 * bytes into separate validated packages.
 */
class ImportedModelRegistryTest {

    private fun shaOf(text: String) = PackageHost.sha256Hex(text.toByteArray())

    @Test
    fun registryPersistsNamespacedEntriesAndDeletesExactlyOne() {
        val root = Files.createTempDirectory("imported-registry-").toFile()
        try {
            val shaA = shaOf("package-a")
            val shaB = shaOf("package-b")
            ImportedModelRegistry.upsert(
                root,
                ImportedModelRegistry.Record(
                    entryId = shaA, label = "Model A", description = "desc",
                    role = "Text", state = "READY", bytes = 10L,
                    packageSha256 = shaA, manifestEntryId = "custom-a"
                )
            )
            ImportedModelRegistry.upsert(
                root,
                ImportedModelRegistry.Record(
                    entryId = shaB, label = "Model B", description = null,
                    role = "Vision", state = "NOT_VERIFIED", bytes = 20L,
                    packageSha256 = shaB, manifestEntryId = "custom-b"
                )
            )
            assertEquals(2, ImportedModelRegistry.list(root).size)
            // Reload from disk (new process view) still sees both.
            assertEquals(2, ImportedModelRegistry.list(root).size)
            assertTrue(ImportedModelRegistry.remove(root, shaA))
            val remaining = ImportedModelRegistry.list(root)
            assertEquals(1, remaining.size)
            assertEquals(shaB, remaining.single().entryId)
            assertFalse(ImportedModelRegistry.remove(root, shaA))
        } finally { root.deleteRecursively() }
    }

    @Test
    fun committerNamespacesByFullShaAndNeverUsesManifestId() {
        val root = Files.createTempDirectory("imported-namespace-").toFile()
        try {
            val inspectionRoot = File(root, "inspection").apply { mkdirs() }
            val store = ModelStore(File(root, "library"))
            val weights = "small data-only LiteRT fixture".toByteArray()
            val hash = PackageHost.sha256Hex(weights)
            val json = """{"packageVersion":"1","entryId":"evil-catalogue-clone","upstream":{"repo":"fixture","rev":"v","file":"model.litertlm"},"createdAt":"2026-09-23T00:00:00Z","files":[{"path":"weights/model.litertlm","bytes":${weights.size},"sha256":"$hash","method":"STORE"}]}"""
            val out = ByteArrayOutputStream()
            java.util.zip.ZipOutputStream(out).use { zip ->
                zip.putNextEntry(java.util.zip.ZipEntry("manifest.json"))
                zip.write(json.toByteArray())
                zip.closeEntry()
                val crc = java.util.zip.CRC32().apply { update(weights) }
                zip.putNextEntry(java.util.zip.ZipEntry("weights/model.litertlm").apply {
                    method = java.util.zip.ZipEntry.STORED; size = weights.size.toLong(); this.crc = crc.value
                })
                zip.write(weights)
                zip.closeEntry()
            }
            val inspected = PackageInspectionStore(inspectionRoot)
                .inspect(out.toByteArray().inputStream(), freeBytes = 1024 * 1024)!!
            val result = PackageCommitter.commitInspected(inspected, store)
            assertTrue(result.ok, result.reason)
            val namespaced = File(store.root, "imported/${inspected.packageSha256}")
            assertTrue(namespaced.isDirectory, "imported identity must be namespaced by full package SHA-256")
            assertFalse(File(store.root, "imported/evil-catalogue-clone").exists())
            ImportedModelRegistry.upsert(
                store.root, ImportedModelRegistry.Record(
                    entryId = inspected.packageSha256, label = "Owner label", role = "Text",
                    state = "READY", bytes = weights.size.toLong(),
                    packageSha256 = inspected.packageSha256, manifestEntryId = "evil-catalogue-clone"
                )
            )
            val specs = ImportedModelRegistry.verifiedExportFiles(store.root, inspected.packageSha256)
            assertEquals(listOf("weights/model.litertlm"), specs?.map { it.path })
            val exported = ByteArrayOutputStream()
            assertTrue(PackageHost.exportPackage(inspected.packageSha256, namespaced, exported, trustedFiles = specs).ok)
            File(namespaced, "weights/model.litertlm").writeText("tampered")
            assertEquals(null, ImportedModelRegistry.verifiedExportFiles(store.root, inspected.packageSha256))
        } finally { root.deleteRecursively() }
    }
}
