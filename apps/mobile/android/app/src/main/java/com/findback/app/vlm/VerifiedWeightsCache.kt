package com.findback.app.vlm

import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Verified-weights cache for candidate status reads.
 *
 * Candidate status used to re-hash installed files on every refresh. This
 * cache keys verified state by size+mtime (plus the expected hash, so a pin
 * change re-verifies): unchanged files return the cached verdict with no
 * I/O; any size/mtime/expected-hash change re-hashes exactly once.
 *
 * Invalidation key: (canonicalPath, length, lastModified, expectedSha256).
 * A missing file always re-checks (never cached as present).
 */
object VerifiedWeightsCache {
    private data class Key(val path: String, val length: Long, val lastModified: Long, val expected: String)

    private val cache = ConcurrentHashMap<String, Pair<Key, Boolean>>()

    /**
     * True when every spec file verifies. [hasher] defaults to the real
     * file hash; tests inject a counting hasher to bound re-hash behaviour.
     */
    fun hasVerifiedWeights(
        store: ModelStore,
        manifest: ModelManifest,
        hasher: (File, String) -> Boolean = Sha256::matchesFile
    ): Boolean {
        if (manifest.files.isEmpty()) return false
        return manifest.files.all { spec -> hasVerifiedFile(store, manifest, spec, hasher) }
    }

    private fun hasVerifiedFile(
        store: ModelStore,
        manifest: ModelManifest,
        spec: ModelFileSpec,
        hasher: (File, String) -> Boolean
    ): Boolean {
        val final = try {
            store.finalFile(manifest, spec)
        } catch (_: Exception) {
            return false
        }
        if (!final.isFile) {
            cache.remove(cacheKey(final, spec))
            return false
        }
        val length = final.length()
        if (length != spec.expectedBytes) {
            cache.remove(cacheKey(final, spec))
            return false
        }
        val lastModified = final.lastModified()
        val mapKey = cacheKey(final, spec)
        val liveKey = Key(mapKey, length, lastModified, spec.sha256.lowercase())
        val cached = cache[mapKey]
        if (cached != null && cached.first == liveKey) return cached.second
        val verified = try {
            hasher(final, spec.sha256)
        } catch (_: Exception) {
            false
        }
        cache[mapKey] = liveKey to verified
        return verified
    }

    private fun cacheKey(file: File, spec: ModelFileSpec): String {
        val path = try {
            file.canonicalPath
        } catch (_: Exception) {
            file.absolutePath
        }
        return "$path|${spec.sha256.lowercase()}"
    }

    fun invalidateAll() {
        cache.clear()
    }
}
