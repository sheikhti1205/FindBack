package com.findback.app.vlm

import java.io.ByteArrayInputStream
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
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * RED: staging recovery on startup — abandoned private staging directories
 * are pruned when older than TTL or unknown to live sessions, including a
 * simulated process restart (new store instance sees the old staging dir).
 */
class StagingRecoveryTest {

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
    fun startupReconcilePrunesAbandonedStagingUnknownToLiveSessions() {
        val root = Files.createTempDirectory("staging-recovery-").toFile()
        try {
            val store = PackageInspectionStore(root)
            val live = store.inspect(ByteArrayInputStream(fixture()), freeBytes = 1024 * 1024)!!
            // Abandoned dir from a dead process: on disk but unknown to live sessions.
            val abandoned = File(root, "staging/dead-session-id")
            abandoned.mkdirs()
            File(abandoned, "package.fbmodel").writeText("partial")
            abandoned.setLastModified(System.currentTimeMillis() - PackageInspectionStore.INSPECTION_TTL_MS - 60_000)
            val pruned = store.reconcileStagingOnStartup()
            assertTrue(pruned >= 1)
            assertFalse(abandoned.exists(), "abandoned staging must be pruned")
            assertNotNull(store.get(live.id), "live session survives reconcile")
            assertTrue(File(root, "staging/${live.id}").exists())
        } finally { root.deleteRecursively() }
    }

    @Test
    fun simulatedRestartCleansOldStagingDir() {
        val root = Files.createTempDirectory("staging-restart-").toFile()
        try {
            val first = PackageInspectionStore(root)
            val inspected = first.inspect(ByteArrayInputStream(fixture()), freeBytes = 1024 * 1024)!!
            val stagingDir = File(root, "staging/${inspected.id}")
            assertTrue(stagingDir.exists())
            // Simulate process death: new store instance, empty in-memory sessions.
            val restarted = PackageInspectionStore(root)
            assertNull(restarted.get(inspected.id))
            // Age the orphan past TTL, then reconcile as startup would.
            stagingDir.setLastModified(System.currentTimeMillis() - PackageInspectionStore.INSPECTION_TTL_MS - 60_000)
            File(stagingDir, "sandbox").setLastModified(System.currentTimeMillis() - PackageInspectionStore.INSPECTION_TTL_MS - 60_000)
            val pruned = restarted.reconcileStagingOnStartup(
                System.currentTimeMillis()
            )
            assertTrue(pruned >= 1)
            assertFalse(stagingDir.exists(), "restart must clean the orphan staging dir")
        } finally { root.deleteRecursively() }
    }

    @Test
    fun freshStagingSurvivesReconcile() {
        val root = Files.createTempDirectory("staging-fresh-").toFile()
        try {
            val store = PackageInspectionStore(root)
            val live = store.inspect(ByteArrayInputStream(fixture()), freeBytes = 1024 * 1024)!!
            val pruned = store.reconcileStagingOnStartup()
            assertEquals(0, pruned)
            assertNotNull(store.get(live.id))
        } finally { root.deleteRecursively() }
    }
}
