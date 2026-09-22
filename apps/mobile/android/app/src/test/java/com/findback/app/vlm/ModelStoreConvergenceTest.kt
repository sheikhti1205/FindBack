package com.findback.app.vlm

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Model-store convergence proofs (workset AA, storage mechanics only).
 *
 * Fixture packages are small synthetic byte ranges — no weight
 * downloads. Layout identity (`<entryId>/<revision>/<file>`) and the
 * verification mechanics (exact SHA at [ModelStore.finalFile], the same
 * call the runtimes resolve) are production-identical; only the byte
 * counts differ. Flat single-file fixtures mirror the Smol and Qwen
 * installed shapes; the export round-trip uses `weights/`-nested spec
 * paths because the package spec requires a `weights/` artifact.
 * No lifecycle or product state is asserted here.
 */
class ModelStoreConvergenceTest {

    private fun fixtureBytes(seed: Int, size: Int): ByteArray =
        ByteArray(size) { index -> ((seed + index * 31) % 251).toByte() }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }
    }

    private data class FixtureFile(val path: String, val bytes: ByteArray)

    private fun fixtureManifest(id: String, revision: String, files: List<FixtureFile>): ModelManifest =
        ModelManifest(
            id = id,
            sourceRepo = "fixture-repo",
            revision = revision,
            files = files.map { ModelFileSpec(it.path, it.bytes.size.toLong(), sha256Hex(it.bytes)) },
            runtime = "fixture-runtime"
        )

    private fun smolManifest(files: List<FixtureFile>): ModelManifest =
        fixtureManifest("smolvlm2-500m", "fixture-smol-rev-01", files)

    private fun qwenManifest(files: List<FixtureFile>): ModelManifest =
        fixtureManifest(QwenTextRuntime.ENTRY_ID, "fixture-qwen-rev-01", files)

    /**
     * Builds a `.fbmodel` whose interior nests artifacts (mirroring the
     * release tooling: `weights/<name>`) while the installed pins live
     * in [manifest]. Import validates whole-package + interior pins;
     * promotion re-verifies against the installed pins.
     */
    private fun packageBytes(entryId: String, interior: List<FixtureFile>): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            val manifestJson = buildString {
                append("{\"packageVersion\": \"1\", \"entryId\": \"$entryId\", ")
                append("\"upstream\": {\"repo\": \"r\", \"rev\": \"v\", \"file\": \"f\"}, ")
                append("\"createdAt\": \"2026-09-22T00:00:00Z\", \"files\": [")
                interior.forEachIndexed { index, file ->
                    val method = if (file.path.startsWith("weights/")) "STORE" else "DEFLATE"
                    append("{\"path\": \"${file.path}\", \"bytes\": ${file.bytes.size}, ")
                    append("\"sha256\": \"${sha256Hex(file.bytes)}\", \"method\": \"$method\"}")
                    if (index < interior.size - 1) append(", ")
                }
                append("]}")
            }
            zip.putNextEntry(ZipEntry(PackageHost.MANIFEST_NAME))
            zip.write(manifestJson.toByteArray(Charsets.UTF_8))
            zip.closeEntry()
            for (file in interior) {
                val entry = ZipEntry(file.path)
                if (file.path.startsWith("weights/")) {
                    val crc = CRC32()
                    crc.update(file.bytes)
                    entry.method = ZipEntry.STORED
                    entry.size = file.bytes.size.toLong()
                    entry.crc = crc.value
                }
                zip.putNextEntry(entry)
                zip.write(file.bytes)
                zip.closeEntry()
            }
        }
        return out.toByteArray()
    }

    private fun tempDir(prefix: String): File = Files.createTempDirectory(prefix).toFile()

    private fun validatedStaging(
        manifest: ModelManifest,
        interior: List<FixtureFile>,
        work: File,
        staging: File
    ): File {
        val pkg = packageBytes(manifest.id, interior)
        val imported = PackageHost.importPackage(
            ByteArrayInputStream(pkg), manifest.id, sha256Hex(pkg), work, staging
        )
        assertTrue(imported.ok, imported.reason)
        return File(staging, manifest.id)
    }

    private fun assertNoPromotionResidue(root: File) {
        val residue = root.walkTopDown().filter { it.isFile }.filter { file ->
            file.name.contains(".promotebak-") ||
                file.name.endsWith(".tmp") ||
                file.name.endsWith(".bak") ||
                file.name.endsWith(".part") ||
                file.name.endsWith(".journal.json")
        }.toList()
        assertTrue(residue.isEmpty(), "promotion residue: ${residue.map { it.absolutePath }}")
    }

    @Test fun smolShapedImportPromotesToExactInstalledSha() {
        val store = ModelStore(tempDir("aa-store-smol"))
        val work = tempDir("aa-work-smol")
        val staging = tempDir("aa-staging-smol")
        val weights = fixtureBytes(7, 2048)
        val manifest = smolManifest(listOf(FixtureFile("SmolVLM2-500M.litertlm", weights)))
        val stagedDir = validatedStaging(
            manifest, listOf(FixtureFile("weights/SmolVLM2-500M.litertlm", weights)), work, staging
        )
        assertTrue(store.promoteValidatedSandbox(manifest, stagedDir), "promotion failed")
        val spec = manifest.files.single()
        val final = store.finalFile(manifest, spec)
        assertTrue(final.isFile, "authoritative final missing: ${final.absolutePath}")
        assertEquals(spec.expectedBytes, final.length())
        assertTrue(Sha256.matchesFile(final, spec.sha256), "installed SHA must match the installed pin exactly")
        assertEquals(sha256Hex(weights), Sha256.ofFile(final))
        assertFalse(File(stagedDir, "weights/SmolVLM2-500M.litertlm").exists(), "staged file must be consumed")
        assertNoPromotionResidue(store.root)
    }

    @Test fun qwenShapedImportPromotesToRuntimeLookupFile() {
        val store = ModelStore(tempDir("aa-store-qwen"))
        val work = tempDir("aa-work-qwen")
        val staging = tempDir("aa-staging-qwen")
        val weights = fixtureBytes(11, 2048)
        val manifest = qwenManifest(listOf(FixtureFile("Qwen3-0.6B_fixture_wi4b32.litertlm", weights)))
        val stagedDir = validatedStaging(
            manifest,
            listOf(FixtureFile("weights/Qwen3-0.6B_fixture_wi4b32.litertlm", weights)),
            work,
            staging
        )
        assertTrue(store.promoteValidatedSandbox(manifest, stagedDir), "promotion failed")
        assertEquals(
            File(store.root, "${QwenTextRuntime.ENTRY_ID}/fixture-qwen-rev-01"),
            store.dirFor(manifest)
        )
        // The same resolution the text runtime uses to find its model file.
        val spec = manifest.files.single()
        val lookup = store.finalFile(manifest, spec)
        assertTrue(lookup.isFile, "runtime lookup file missing: ${lookup.absolutePath}")
        assertTrue(Sha256.matchesFile(lookup, spec.sha256), "lookup file must carry the exact installed SHA")
        assertNoPromotionResidue(store.root)
    }

    @Test fun realManifestsResolveToAuthoritativeLayout() {
        val store = ModelStore(tempDir("aa-layout"))
        val smol = MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }
        assertEquals(File(store.root, "smolvlm2-500m/${smol.revision}"), store.dirFor(smol))
        assertEquals(
            File(store.dirFor(smol), "SmolVLM2-500M.litertlm"),
            store.finalFile(smol, smol.files.single())
        )
        val qwen = QwenTextRuntime.manifest()
        assertEquals(
            File(store.root, "${QwenTextRuntime.ENTRY_ID}/${qwen.revision}"),
            store.dirFor(qwen)
        )
        assertEquals(
            File(store.dirFor(qwen), QwenTextRuntime.MODEL_FILE_NAME),
            store.finalFile(qwen, qwen.files.single())
        )
    }

    @Test fun importDeleteLeavesZeroResidue() {
        val store = ModelStore(tempDir("aa-store-delete"))
        val work = tempDir("aa-work-delete")
        val staging = tempDir("aa-staging-delete")
        val smolWeights = fixtureBytes(7, 1024)
        val smol = smolManifest(listOf(FixtureFile("SmolVLM2-500M.litertlm", smolWeights)))
        val smolStaged = validatedStaging(
            smol, listOf(FixtureFile("weights/SmolVLM2-500M.litertlm", smolWeights)), work, staging
        )
        assertTrue(store.promoteValidatedSandbox(smol, smolStaged))
        val siblingDir = File(store.root, "smolvlm-256m/fixture-rev")
        siblingDir.mkdirs()
        val siblingFile = File(siblingDir, "sibling.bin")
        siblingFile.writeBytes(fixtureBytes(13, 128))

        store.deleteModel(VlmModelId.SMOLVLM2_500M)
        assertFalse(File(store.root, "smolvlm2-500m").exists(), "smol prefix must be gone")
        assertTrue(siblingFile.isFile, "sibling entry must be untouched")

        val qwenWeights = fixtureBytes(11, 1024)
        val qwen = qwenManifest(listOf(FixtureFile("Qwen3-0.6B_fixture_wi4b32.litertlm", qwenWeights)))
        val qwenStaged = validatedStaging(
            qwen,
            listOf(FixtureFile("weights/Qwen3-0.6B_fixture_wi4b32.litertlm", qwenWeights)),
            tempDir("aa-work-delete-q"),
            tempDir("aa-staging-delete-q")
        )
        assertTrue(store.promoteValidatedSandbox(qwen, qwenStaged))
        store.deleteEntry(QwenTextRuntime.ENTRY_ID)
        assertFalse(
            File(store.root, QwenTextRuntime.ENTRY_ID).exists(),
            "qwen prefix (all revisions, artifacts, records) must be gone"
        )
        assertTrue(siblingFile.isFile, "sibling entry must still be untouched")
        assertNoPromotionResidue(store.root)
    }

    @Test fun importExportReimportRoundTrip() {
        val storeA = ModelStore(tempDir("aa-store-a"))
        val storeB = ModelStore(tempDir("aa-store-b"))
        val weights = fixtureBytes(7, 2048)
        val vocab = "{\"vocab\": [\"hello\", \"world\"]}".toByteArray(Charsets.UTF_8)
        val manifest = smolManifest(
            listOf(
                FixtureFile("weights/rt-model.litertlm", weights),
                FixtureFile("tokenizer/vocab.json", vocab)
            )
        )
        val stagedA = validatedStaging(
            manifest,
            listOf(
                FixtureFile("weights/rt-model.litertlm", weights),
                FixtureFile("tokenizer/vocab.json", vocab)
            ),
            tempDir("aa-work-a"),
            tempDir("aa-staging-a")
        )
        assertTrue(storeA.promoteValidatedSandbox(manifest, stagedA))

        // Export reverses from the same authoritative files.
        val exported = ByteArrayOutputStream()
        val exportResult = PackageHost.exportPackage(manifest.id, storeA.dirFor(manifest), exported)
        assertTrue(exportResult.ok, exportResult.reason)
        for (spec in manifest.files) {
            val exportedFile = exportResult.manifest!!.files.single { it.path == spec.path }
            assertEquals(spec.sha256, exportedFile.sha256, "export must carry the installed pin for ${spec.path}")
        }

        val stagingB = tempDir("aa-staging-b")
        val pkg = exported.toByteArray()
        val reimported = PackageHost.importPackage(
            ByteArrayInputStream(pkg), manifest.id, sha256Hex(pkg), tempDir("aa-work-b"), stagingB
        )
        assertTrue(reimported.ok, reimported.reason)
        assertTrue(storeB.promoteValidatedSandbox(manifest, File(stagingB, manifest.id)))
        for (spec in manifest.files) {
            val final = storeB.finalFile(manifest, spec)
            assertTrue(final.isFile, "re-imported final missing: ${spec.path}")
            assertTrue(Sha256.matchesFile(final, spec.sha256), "round-trip SHA must match for ${spec.path}")
        }
        assertNoPromotionResidue(storeB.root)
    }

    @Test fun promotionRejectsTamperedInteriorWithNothingInstalled() {
        val store = ModelStore(tempDir("aa-store-tamper"))
        val work = tempDir("aa-work-tamper")
        val staging = tempDir("aa-staging-tamper")
        val weights = fixtureBytes(7, 1024)
        val manifest = smolManifest(listOf(FixtureFile("SmolVLM2-500M.litertlm", weights)))
        val stagedDir = validatedStaging(
            manifest, listOf(FixtureFile("weights/SmolVLM2-500M.litertlm", weights)), work, staging
        )
        val stagedFile = File(stagedDir, "weights/SmolVLM2-500M.litertlm")
        val tampered = stagedFile.readBytes()
        tampered[512] = (tampered[512].toInt() xor 0xFF).toByte()
        stagedFile.writeBytes(tampered)
        assertFalse(store.promoteValidatedSandbox(manifest, stagedDir), "tampered interior must not promote")
        val targetDir = store.dirFor(manifest)
        val installed = if (targetDir.exists()) {
            targetDir.walkTopDown().filter { it.isFile }.toList()
        } else {
            emptyList()
        }
        assertTrue(installed.isEmpty(), "nothing may be installed: $installed")
        assertTrue(stagedFile.isFile, "failed verification must not consume the staging dir")
    }

    @Test fun promotionFailureRestoresPriorGoodFinal() {
        val store = ModelStore(tempDir("aa-store-rollback"))
        val weights = fixtureBytes(7, 512)
        val vocab = fixtureBytes(17, 256)
        val manifest = smolManifest(
            listOf(
                FixtureFile("weights/rt-model.litertlm", weights),
                FixtureFile("tokenizer/deep/vocab.json", vocab)
            )
        )
        val stagedV1 = validatedStaging(
            manifest,
            listOf(
                FixtureFile("weights/rt-model.litertlm", weights),
                FixtureFile("tokenizer/deep/vocab.json", vocab)
            ),
            tempDir("aa-work-r1"),
            tempDir("aa-staging-r1")
        )
        assertTrue(store.promoteValidatedSandbox(manifest, stagedV1))

        // Re-stage identical verified content, then block the second
        // final's parent dir with a regular file so the second move
        // fails mid-run after the first file already moved.
        val stagedV2 = validatedStaging(
            manifest,
            listOf(
                FixtureFile("weights/rt-model.litertlm", weights),
                FixtureFile("tokenizer/deep/vocab.json", vocab)
            ),
            tempDir("aa-work-r2"),
            tempDir("aa-staging-r2")
        )
        val firstSpec = manifest.files[0]
        val tokenizerDir = File(store.dirFor(manifest), "tokenizer")
        assertTrue(tokenizerDir.isDirectory, "test setup: nested parent must exist")
        deleteRecursively(tokenizerDir)
        tokenizerDir.writeBytes(byteArrayOf(9))
        assertFalse(store.promoteValidatedSandbox(manifest, stagedV2), "blocked move must fail")

        val firstFinal = store.finalFile(manifest, firstSpec)
        assertTrue(firstFinal.isFile, "prior good final must be restored")
        assertTrue(
            Sha256.matchesFile(firstFinal, firstSpec.sha256),
            "restored final must still carry the exact installed SHA"
        )
        assertEquals(sha256Hex(weights), Sha256.ofFile(firstFinal))
        assertTrue(
            File(store.dirFor(manifest), "tokenizer").isFile,
            "blocking file must be left alone"
        )
        assertNoPromotionResidue(store.root)
    }

    private fun deleteRecursively(file: File) {
        if (file.isDirectory) {
            file.listFiles()?.forEach { deleteRecursively(it) }
        }
        file.delete()
    }

    @Test fun failedExportLeavesAuthoritativeFilesUntouched() {
        val store = ModelStore(tempDir("aa-store-exportfail"))
        val weights = fixtureBytes(7, 1024)
        val vocab = fixtureBytes(17, 128)
        val manifest = smolManifest(
            listOf(
                FixtureFile("weights/rt-model.litertlm", weights),
                FixtureFile("tokenizer/vocab.json", vocab)
            )
        )
        val staged = validatedStaging(
            manifest,
            listOf(
                FixtureFile("weights/rt-model.litertlm", weights),
                FixtureFile("tokenizer/vocab.json", vocab)
            ),
            tempDir("aa-work-ef"),
            tempDir("aa-staging-ef")
        )
        assertTrue(store.promoteValidatedSandbox(manifest, staged))
        val failing = object : OutputStream() {
            override fun write(b: Int): Unit = throw java.io.IOException("no space")
        }
        val result = PackageHost.exportPackage(manifest.id, store.dirFor(manifest), failing)
        assertFalse(result.ok, "failing writer must not claim a package")
        for (spec in manifest.files) {
            val final = store.finalFile(manifest, spec)
            assertTrue(Sha256.matchesFile(final, spec.sha256), "authoritative file must be untouched: ${spec.path}")
        }
    }

    @Test fun flatAuthoritativeExportFailsClosedMissingWeights() {
        val store = ModelStore(tempDir("aa-store-flat"))
        val weights = fixtureBytes(7, 1024)
        val manifest = smolManifest(listOf(FixtureFile("SmolVLM2-500M.litertlm", weights)))
        val staged = validatedStaging(
            manifest, listOf(FixtureFile("weights/SmolVLM2-500M.litertlm", weights)),
            tempDir("aa-work-flat"), tempDir("aa-staging-flat")
        )
        assertTrue(store.promoteValidatedSandbox(manifest, staged))
        val result = PackageHost.exportPackage(manifest.id, store.dirFor(manifest), ByteArrayOutputStream())
        assertFalse(result.ok, "flat spec paths carry no weights/ artifact under the package spec")
        assertEquals(PackageHost.Code.MISSING_WEIGHTS, result.code)
        val spec = manifest.files.single()
        assertTrue(
            Sha256.matchesFile(store.finalFile(manifest, spec), spec.sha256),
            "refused export must leave authoritative files untouched"
        )
    }
}
