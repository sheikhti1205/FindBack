package com.findback.app.vlm

import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * RED: export/import round-trip for all six catalogue identities.
 * Export writes a fresh package (new timestamp -> new container bytes) so
 * exact whole-package SHA recognition fails on re-import; exported manifests
 * must carry declared entryId + per-file hashes + an export marker, and
 * inspection must accept re-exported packages IFF the declared entryId is one
 * of the six catalogue IDs AND every artifact hash equals trusted
 * native-side pins (never the manifest self-declaration alone).
 */
class SixModelRoundTripTest {

    private val six = listOf(
        "smolvlm2-500m-litert-int4",
        "qwen3-0.6b-litert-dynamic-int4",
        "qwen3-0.6b-litert-mixed-int4",
        "qwen3-0.6b-litert-int8",
        "lfm2.5-1.2b-instruct-litert-int4-gpu",
        "lfm2.5-vl-450m"
    )

    @Test
    fun sixCatalogueListsAllSixEntryIds() {
        assertEquals(six.toSet(), SixModelCatalogue.ALL_SIX.toSet())
    }

    @Test
    fun exportedManifestCarriesEntryIdHashesAndExportMarker() {
        val root = Files.createTempDirectory("roundtrip-marker-").toFile()
        try {
            val installDir = File(root, "install").apply { mkdirs() }
            File(installDir, "weights").mkdirs()
            val weights = "weights-for-marker".toByteArray()
            File(installDir, "weights/model.litertlm").writeBytes(weights)
            val out = ByteArrayOutputStream()
            val result = PackageHost.exportPackage("smolvlm2-500m-litert-int4", installDir, out)
            assertTrue(result.ok, result.reason)
            val manifest = assertNotNull(result.manifest)
            assertEquals("smolvlm2-500m-litert-int4", manifest.entryId)
            assertTrue(manifest.exported, "exported packages must carry an export marker")
            assertTrue(manifest.files.any { it.sha256.equals(PackageHost.sha256Hex(weights), ignoreCase = true) })
        } finally { root.deleteRecursively() }
    }

    @Test
    fun exportDeleteImportRestoresSameRowAndExactShaForAllSix() {
        for (entryId in six) {
            val root = Files.createTempDirectory("roundtrip-six-").toFile()
            try {
                val storeRoot = File(root, "store").apply { mkdirs() }
                val inspectionRoot = File(root, "inspections").apply { mkdirs() }
                // Small representative fixture per entry (not real weights).
                val weights = "fixture-weights-for-$entryId".toByteArray()
                val weightHash = PackageHost.sha256Hex(weights)
                val spec = ModelFileSpec("model.litertlm", weights.size.toLong(), weightHash)
                val manifest = ModelManifest(
                    id = "fixture-$entryId",
                    sourceRepo = "fixture/repo",
                    revision = "fixture-rev-$entryId",
                    runtime = "fixture",
                    files = listOf(spec)
                )
                // Installed catalogue row.
                val store = ModelStore(storeRoot)
                val dir = store.dirFor(manifest)
                dir.mkdirs()
                File(dir, spec.path).writeBytes(weights)
                // Native-side trust recorded at download/verify time (tombstone).
                ExportTrustStore.record(storeRoot, entryId, listOf(spec))

                // Export the installed row.
                val exported = ByteArrayOutputStream()
                val exportResult = PackageHost.exportPackage(entryId, dir, exported)
                assertTrue(exportResult.ok, "$entryId: ${exportResult.reason}")

                // Delete the catalogue row (trust tombstone survives).
                store.deleteEntry(manifest.id)
                assertTrue(ExportTrustStore.trustedFor(storeRoot, entryId) != null)

                // Re-import the exported package: whole-package SHA is fresh,
                // so exact-byte recognition must fail but re-export path accepts.
                val exportedBytes = exported.toByteArray()
                val inspectionStore = PackageInspectionStore(
                    inspectionRoot,
                    trustRoot = storeRoot
                )
                val inspected = inspectionStore.inspect(
                    exportedBytes.inputStream(),
                    freeBytes = 1024 * 1024
                )
                assertNotNull(inspected, "$entryId re-export must inspect")
                assertTrue(!inspected.unknown, "$entryId re-export is catalogue, not unknown")

                // Promote back into the same catalogue row.
                val commit = PackageCommitter.commitReexportedInspected(inspected, store, manifest)
                assertTrue(commit.ok, "$entryId: ${commit.reason}")
                val restored = store.finalFile(manifest, spec)
                assertTrue(restored.isFile, "$entryId same catalogue row restored")
                assertEquals(weightHash, Sha256.ofFile(restored), "$entryId exact installed SHA restored")
            } finally { root.deleteRecursively() }
        }
    }

    @Test
    fun reexportWithForgedArtifactHashIsRejected() {
        val root = Files.createTempDirectory("roundtrip-forge-").toFile()
        try {
            val storeRoot = File(root, "store").apply { mkdirs() }
            val inspectionRoot = File(root, "inspections").apply { mkdirs() }
            val entryId = "lfm2.5-vl-450m"
            val real = "real-fixture-weights".toByteArray()
            val realSpec = ModelFileSpec("model.litertlm", real.size.toLong(), PackageHost.sha256Hex(real))
            ExportTrustStore.record(storeRoot, entryId, listOf(realSpec))
            // Attacker package self-declares the catalogue id with other bytes + marker.
            val evil = "evil-weights".toByteArray()
            val evilHash = PackageHost.sha256Hex(evil)
            val json = """{"packageVersion":"1","entryId":"$entryId","exported":true,"upstream":{"repo":"x","rev":"y","file":"z"},"createdAt":"2026-09-23T00:00:00Z","files":[{"path":"weights/model.litertlm","bytes":${evil.size},"sha256":"$evilHash","method":"STORE"}]}"""
            val out = ByteArrayOutputStream()
            java.util.zip.ZipOutputStream(out).use { zip ->
                zip.putNextEntry(java.util.zip.ZipEntry("manifest.json"))
                zip.write(json.toByteArray())
                zip.closeEntry()
                val crc = java.util.zip.CRC32().apply { update(evil) }
                zip.putNextEntry(java.util.zip.ZipEntry("weights/model.litertlm").apply {
                    method = java.util.zip.ZipEntry.STORED; size = evil.size.toLong(); this.crc = crc.value
                })
                zip.write(evil)
                zip.closeEntry()
            }
            val inspected = PackageInspectionStore(inspectionRoot, trustRoot = storeRoot)
                .inspect(out.toByteArray().inputStream(), freeBytes = 1024 * 1024)
            assertEquals(null, inspected, "self-declared manifest alone must never suffice")
        } finally { root.deleteRecursively() }
    }
}
