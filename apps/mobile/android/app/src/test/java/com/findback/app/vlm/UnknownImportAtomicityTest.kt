package com.findback.app.vlm

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * RED: atomic unknown import — file promotion + registry upsert are one
 * recoverable transaction; deletion removes files first, verifies, then
 * updates the registry.
 */
class UnknownImportAtomicityTest {

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

    private fun recordFor(inspected: PackageInspectionStore.InspectedPackage, label: String = "Owner"): ImportedModelRegistry.Record {
        val namespaced = ImportCommitPolicy.namespacedEntryId(inspected.packageSha256)!!
        return ImportedModelRegistry.Record(
            entryId = namespaced,
            label = label,
            role = "Text",
            state = ImportedModelRegistry.STATE_READY,
            bytes = 1L,
            packageSha256 = inspected.packageSha256.lowercase(),
            manifestEntryId = inspected.manifest.entryId
        )
    }

    @Test
    fun registryWriteFailureAfterPromotionRollsBackAndReportsFailure() {
        val root = Files.createTempDirectory("atomic-rollback-").toFile()
        try {
            val inspectionRoot = File(root, "inspection").apply { mkdirs() }
            val store = ModelStore(File(root, "library"))
            val inspected = PackageInspectionStore(inspectionRoot)
                .inspect(unknownFixture().inputStream(), freeBytes = 1024 * 1024)!!
            val record = recordFor(inspected)
            val result = PackageCommitter.commitUnknownAtomically(
                inspected, store, record,
                registryWriter = { throw IllegalStateException("registry disk full") }
            )
            assertFalse(result.ok)
            val namespaced = ImportCommitPolicy.namespacedEntryId(inspected.packageSha256)!!
            assertFalse(File(store.root, "imported/$namespaced").exists(), "promoted files must be removed on registry failure")
            assertTrue(ImportedModelRegistry.list(store.root).none { it.entryId == namespaced })
        } finally { root.deleteRecursively() }
    }

    @Test
    fun interruptedCommitRetriesWithoutAlreadyExistsDeadEnd() {
        val root = Files.createTempDirectory("atomic-retry-").toFile()
        try {
            val inspectionRoot = File(root, "inspection").apply { mkdirs() }
            val store = ModelStore(File(root, "library"))
            // First attempt promotes files but "crashes" before the registry write.
            val first = PackageInspectionStore(inspectionRoot)
                .inspect(unknownFixture().inputStream(), freeBytes = 1024 * 1024)!!
            val namespaced = ImportCommitPolicy.namespacedEntryId(first.packageSha256)!!
            val partial = PackageCommitter.commitInspected(first, store)
            assertTrue(partial.ok, partial.reason)
            assertTrue(ImportedModelRegistry.list(store.root).none { it.entryId == namespaced })
            // Retry with a fresh inspection of the same package must succeed
            // (reconciles the existing target dir, never an "already exists" dead-end).
            val retry = PackageInspectionStore(inspectionRoot)
                .inspect(unknownFixture().inputStream(), freeBytes = 1024 * 1024)!!
            val record = recordFor(retry)
            val result = PackageCommitter.commitUnknownAtomically(retry, store, record)
            assertTrue(result.ok, result.reason)
            assertTrue(File(store.root, "imported/$namespaced/weights/model.litertlm").isFile)
            assertTrue(ImportedModelRegistry.list(store.root).any { it.entryId == namespaced })
        } finally { root.deleteRecursively() }
    }

    @Test
    fun deletionRemovesFilesFirstAndKeepsRegistryOnFailure() {
        val root = Files.createTempDirectory("atomic-delete-").toFile()
        try {
            val sha = PackageHost.sha256Hex("package-x".toByteArray())
            ImportedModelRegistry.upsert(
                root,
                ImportedModelRegistry.Record(
                    entryId = sha, label = "X", role = "Text", state = "READY",
                    bytes = 10L, packageSha256 = sha, manifestEntryId = "custom-x"
                )
            )
            File(File(root, "imported"), sha).mkdirs()
            File(File(root, "imported"), "$sha/weights.bin").writeText("bytes")
            val failed = ImportedModelRegistry.removeWithResult(root, sha, deleteOp = { false })
            assertFalse(failed.ok, "deletion failure must report an error")
            assertTrue(ImportedModelRegistry.list(root).any { it.entryId == sha }, "registry stays intact on deletion failure")
            val ok = ImportedModelRegistry.removeWithResult(root, sha)
            assertTrue(ok.ok)
            assertFalse(File(File(root, "imported"), sha).exists(), "deleted model files are exactly cleaned up")
            assertTrue(ImportedModelRegistry.list(root).none { it.entryId == sha })
        } finally { root.deleteRecursively() }
    }

    @Test
    fun legacyRemoveDeletesFilesFirstThenRegistry() {
        val root = Files.createTempDirectory("atomic-legacy-delete-").toFile()
        try {
            val sha = PackageHost.sha256Hex("package-y".toByteArray())
            ImportedModelRegistry.upsert(
                root,
                ImportedModelRegistry.Record(
                    entryId = sha, label = "Y", role = "Vision", state = "READY",
                    bytes = 5L, packageSha256 = sha, manifestEntryId = "custom-y"
                )
            )
            val dir = File(File(root, "imported"), sha).apply { mkdirs() }
            File(dir, "weights/model.litertlm").apply { parentFile.mkdirs(); writeText("w") }
            assertTrue(ImportedModelRegistry.remove(root, sha))
            assertFalse(dir.exists())
            assertEquals(0, ImportedModelRegistry.list(root).size)
        } finally { root.deleteRecursively() }
    }
}
