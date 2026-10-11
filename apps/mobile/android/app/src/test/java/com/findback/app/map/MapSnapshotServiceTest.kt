package com.findback.app.map

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * Pure-JVM tests for [MapSnapshotService] file/cache logic. Rendering itself
 * needs the MapLibre runtime and is covered on-device (MAP-11).
 */
class MapSnapshotServiceTest {

    @get:Rule
    val temp = TemporaryFolder()

    @Test fun snapshotFileNameIsKeyScoped() {
        val dir = temp.newFolder("snaps")
        val file: File = MapSnapshotService.snapshotFile(dir, "abc123")
        assertEquals(File(dir, "abc123.png"), file)
        assertFalse(file.absolutePath.contains(".."))
    }

    @Test fun evictionKeepsNewestUnderCap() {
        val dir = temp.newFolder("snaps")
        val now = System.currentTimeMillis()
        // oldest → newest, 10 bytes each.
        val files = (0 until 5).map { i ->
            File(dir, "f$i.png").also {
                it.writeBytes(ByteArray(10) { i.toByte() })
                it.setLastModified(now - (5 - i) * 1000L)
            }
        }
        MapSnapshotService.evictOldest(dir, 25L)
        val remaining = dir.listFiles()!!.map { it.name }.toSet()
        // 50 bytes total → evict the two oldest (f0, f1), keep 30... still
        // over 25 → evict f2 as well, keep the two newest.
        assertEquals(setOf("f3.png", "f4.png"), remaining)
        assertTrue(files[3].exists() && files[4].exists())
    }

    @Test fun evictionIsANoOpUnderCap() {
        val dir = temp.newFolder("snaps")
        File(dir, "keep.png").writeBytes(ByteArray(10))
        MapSnapshotService.evictOldest(dir, 1024L)
        assertTrue(File(dir, "keep.png").exists())
    }

    @Test fun pixelRatioClamp() {
        assertEquals(1.0f, MapSnapshotService.clampPixelRatio(null))
        assertEquals(1.0f, MapSnapshotService.clampPixelRatio(Float.NaN))
        assertEquals(1.0f, MapSnapshotService.clampPixelRatio(0.5f))
        assertEquals(2.0f, MapSnapshotService.clampPixelRatio(9.0f))
        assertEquals(1.5f, MapSnapshotService.clampPixelRatio(1.5f))
    }
}
