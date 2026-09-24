package com.findback.app.vlm

import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * RED: status-hash perf — verified state is cached keyed by size+mtime so an
 * unchanged file is not re-hashed on every refresh; a changed file re-hashes.
 */
class WeightHashCacheTest {

    @Test
    fun unchangedFilesAreNotRehashed() {
        val root = Files.createTempDirectory("hash-cache-").toFile()
        try {
            val bytes = "cache fixture weights".toByteArray()
            val manifest = ModelManifest(
                id = "cache-entry", sourceRepo = "example/model", revision = "rev",
                runtime = "fixture",
                files = listOf(ModelFileSpec("model.litertlm", bytes.size.toLong(), PackageHost.sha256Hex(bytes)))
            )
            val store = ModelStore(root)
            store.finalFile(manifest, manifest.files.single()).apply {
                parentFile.mkdirs(); writeBytes(bytes)
            }
            VerifiedWeightsCache.invalidateAll()
            val calls = AtomicInteger(0)
            val countingHasher: (File, String) -> Boolean = { file, expected ->
                calls.incrementAndGet()
                Sha256.matchesFile(file, expected)
            }
            assertTrue(VerifiedWeightsCache.hasVerifiedWeights(store, manifest, countingHasher))
            assertEquals(1, calls.get())
            assertTrue(VerifiedWeightsCache.hasVerifiedWeights(store, manifest, countingHasher))
            assertEquals(1, calls.get(), "no re-hash when size+mtime unchanged")
        } finally { root.deleteRecursively() }
    }

    @Test
    fun changedFilesRehashAndTamperingIsDetected() {
        val root = Files.createTempDirectory("hash-cache-change-").toFile()
        try {
            val bytes = "cache fixture weights!".toByteArray()
            val manifest = ModelManifest(
                id = "cache-entry-2", sourceRepo = "example/model", revision = "rev",
                runtime = "fixture",
                files = listOf(ModelFileSpec("model.litertlm", bytes.size.toLong(), PackageHost.sha256Hex(bytes)))
            )
            val store = ModelStore(root)
            val final = store.finalFile(manifest, manifest.files.single()).apply {
                parentFile.mkdirs(); writeBytes(bytes)
            }
            VerifiedWeightsCache.invalidateAll()
            val calls = AtomicInteger(0)
            val countingHasher: (File, String) -> Boolean = { file, expected ->
                calls.incrementAndGet()
                Sha256.matchesFile(file, expected)
            }
            assertTrue(VerifiedWeightsCache.hasVerifiedWeights(store, manifest, countingHasher))
            // Same byte length, different content, bumped mtime -> must re-hash and fail.
            val tampered = bytes.copyOf().also { it[0] = (it[0].toInt() xor 0xFF).toByte() }
            Thread.sleep(5)
            final.writeBytes(tampered)
            assertFalse(VerifiedWeightsCache.hasVerifiedWeights(store, manifest, countingHasher))
            assertTrue(calls.get() >= 2, "changed file must re-hash")
        } finally { root.deleteRecursively() }
    }
}
