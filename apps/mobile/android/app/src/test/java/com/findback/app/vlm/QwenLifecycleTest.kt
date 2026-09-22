package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class QwenLifecycleTest {

    private fun root(): File =
        File.createTempFile("findback-models", "").apply { delete(); mkdirs() }

    private fun fixtureBytes(): ByteArray =
        ByteArray(64) { i -> ((i * 7 + 3) and 0xff).toByte() }

    /** Small-fixture manifest with a true hash pin (never real weights). */
    private fun fixtureManifest(bytes: ByteArray): ModelManifest {
        val dir = File.createTempFile("qwen-fixture", "").apply { delete(); mkdirs() }
        val probe = File(dir, "probe.bin")
        probe.writeBytes(bytes)
        val sha = Sha256.ofFile(probe)
        dir.deleteRecursively()
        return ModelManifest(
            id = QwenTextRuntime.ENTRY_ID,
            sourceRepo = QwenTextRuntime.SOURCE_REPO,
            revision = "test-rev",
            files = listOf(
                ModelFileSpec(
                    path = QwenTextRuntime.MODEL_FILE_NAME,
                    expectedBytes = bytes.size.toLong(),
                    sha256 = sha
                )
            ),
            runtime = QwenTextRuntime.RUNTIME
        )
    }

    private fun writeFinal(root: File, manifest: ModelManifest, bytes: ByteArray): File {
        val final = File(File(root, "${manifest.id}/${manifest.revision}"), manifest.files.first().path)
        final.parentFile?.mkdirs()
        final.writeBytes(bytes)
        return final
    }

    private fun validRecord(manifest: ModelManifest): QwenTextStateRecord =
        QwenTextStateRecord(
            entryId = manifest.id,
            revision = manifest.revision,
            state = VlmState.INSTALLED_UNVERIFIED,
            installedBytes = manifest.files.first().expectedBytes,
            installTimestamp = 1L,
            installedSha256 = manifest.files.first().sha256
        )

    @Test fun stateRecordRoundTripsUnderEntryDir() {
        val storeRoot = root()
        assertNull(QwenLifecycle.loadState(storeRoot))
        val record = validRecord(fixtureManifest(fixtureBytes()))
        QwenLifecycle.saveState(storeRoot, record)
        assertEquals(
            File(File(storeRoot, QwenTextRuntime.ENTRY_ID), "text-state.json"),
            QwenLifecycle.stateFile(storeRoot)
        )
        assertEquals(record, QwenLifecycle.loadState(storeRoot))
    }

    @Test fun installedRequiresVerifiedRecordPlusMatchingFile() {
        val storeRoot = root()
        val bytes = fixtureBytes()
        val manifest = fixtureManifest(bytes)
        val record = validRecord(manifest)
        // Record alone, without the file, is never installed.
        assertFalse(QwenLifecycle.isInstalledValid(storeRoot, record, manifest))
        writeFinal(storeRoot, manifest, bytes)
        assertTrue(QwenLifecycle.isInstalledValid(storeRoot, record, manifest))
        assertTrue(QwenLifecycle.isFilePresent(storeRoot, manifest))
    }

    @Test fun presentFileAloneIsNeverInstalled() {
        val storeRoot = root()
        val bytes = fixtureBytes()
        val manifest = fixtureManifest(bytes)
        writeFinal(storeRoot, manifest, bytes)
        assertTrue(QwenLifecycle.isFilePresent(storeRoot, manifest))
        assertFalse(QwenLifecycle.isInstalledValid(storeRoot, null, manifest))
        assertFalse(
            QwenLifecycle.isInstalledValid(
                storeRoot,
                validRecord(manifest).copy(state = VlmState.DOWNLOADING),
                manifest
            )
        )
    }

    @Test fun installedRejectsSizeHashAndRevisionDrift() {
        val storeRoot = root()
        val bytes = fixtureBytes()
        val manifest = fixtureManifest(bytes)
        val record = validRecord(manifest)
        // Truncated file.
        writeFinal(storeRoot, manifest, bytes.copyOf(32))
        assertFalse(QwenLifecycle.isInstalledValid(storeRoot, record, manifest))
        // Correct size, wrong bytes.
        val tampered = bytes.copyOf().also { it[0] = (it[0] + 1).toByte() }
        writeFinal(storeRoot, manifest, tampered)
        // Size matches but the carried hash no longer pins the spec.
        assertFalse(
            QwenLifecycle.isInstalledValid(
                storeRoot,
                record.copy(installedSha256 = "0".repeat(64)),
                manifest
            )
        )
        // Revision drift re-blocks until re-qualified.
        writeFinal(storeRoot, manifest, bytes)
        assertFalse(
            QwenLifecycle.isInstalledValid(
                storeRoot,
                record.copy(revision = "other-rev"),
                manifest
            )
        )
    }

    @Test fun bootReconciliationParksTransientStates() {
        val downloading = QwenTextStateRecord(state = VlmState.DOWNLOADING)
        assertEquals(VlmState.PAUSED, QwenLifecycle.reconcileAtBoot(downloading, partExists = true))
        assertEquals(VlmState.NOT_INSTALLED, QwenLifecycle.reconcileAtBoot(downloading, partExists = false))
        assertEquals(VlmState.NOT_INSTALLED, QwenLifecycle.reconcileAtBoot(null, partExists = true))
        val installed = QwenTextStateRecord(state = VlmState.INSTALLED_UNVERIFIED)
        assertEquals(VlmState.INSTALLED_UNVERIFIED, QwenLifecycle.reconcileAtBoot(installed, partExists = false))
        val paused = QwenTextStateRecord(state = VlmState.PAUSED)
        assertEquals(VlmState.PAUSED, QwenLifecycle.reconcileAtBoot(paused, partExists = false))
    }

    @Test fun textReadyRequiresSuccessPlusCanonicalState() {
        assertTrue(QwenLifecycle.isTextReady(true, TextRuntimeController.STATE_READY))
        assertFalse(QwenLifecycle.isTextReady(true, TextRuntimeController.STATE_UNAVAILABLE))
        assertFalse(QwenLifecycle.isTextReady(false, TextRuntimeController.STATE_READY))
    }

    @Test fun statusCarriesFrozenIdentity() {
        val status = QwenLifecycle.composeStatus(
            installed = true,
            modelFilePresent = true,
            textReady = true,
            residentModelId = QwenTextRuntime.BRIDGE_MODEL_ID
        )
        assertEquals(QwenTextRuntime.ENTRY_ID, status.entryId)
        assertEquals(QwenTextRuntime.BRIDGE_MODEL_ID, status.modelId)
        assertTrue(status.installed)
        assertTrue(status.modelFilePresent)
        assertTrue(status.textReady)
        assertEquals(QwenTextRuntime.BRIDGE_MODEL_ID, status.residentModelId)
    }

    @Test fun deleteRemovesExactlyThatModel() {
        val storeRoot = root()
        val bytes = fixtureBytes()
        val manifest = fixtureManifest(bytes)
        writeFinal(storeRoot, manifest, bytes)
        val spec = manifest.files.first()
        val dir = File(storeRoot, "${manifest.id}/${manifest.revision}")
        File(dir, "${spec.path}.part").writeBytes(byteArrayOf(1, 2, 3))
        File(dir, "${spec.path}.journal.json").writeBytes(byteArrayOf(4, 5))
        QwenLifecycle.saveState(storeRoot, validRecord(manifest))
        // Sibling model residue that must survive.
        val sibling = File(storeRoot, "smolvlm2-500m/rev/SmolVLM2-500M.litertlm")
        sibling.parentFile?.mkdirs()
        sibling.writeBytes(byteArrayOf(9))

        val deleted = QwenLifecycle.deleteExactly(storeRoot)

        assertTrue(deleted.contains("${manifest.revision}/${QwenTextRuntime.MODEL_FILE_NAME}"))
        assertTrue(deleted.contains("${manifest.revision}/${QwenTextRuntime.MODEL_FILE_NAME}.part"))
        assertTrue(deleted.contains("text-state.json"))
        assertFalse(File(storeRoot, QwenTextRuntime.ENTRY_ID).exists())
        assertTrue(sibling.exists())
        assertTrue(deleted.none { it.startsWith("smolvlm2-500m/") })
    }

    @Test fun deleteOfMissingEntryDeletesNothing() {
        assertEquals(emptyList(), QwenLifecycle.deleteExactly(root()))
    }
}
