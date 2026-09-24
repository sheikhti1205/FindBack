package com.findback.app.vlm

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipFile

/**
 * Stages a user-picked `.fbmodel` for the import flow: the SAF stream is
 * written to a per-inspection session directory with an incremental
 * whole-package SHA-256, the data-only invariants are verified (safe
 * paths, no symlinks, no executables, manifest-declared sizes and
 * hashes), and members are extracted to a session sandbox.
 *
 * Inspection never installs anything into the model library: sessions
 * live under `[root]/staging/<random-id>/` and only an explicit commit
 * step (which must re-hash the staged file and re-check the recorded
 * whole-package digest) may promote a session.
 *
 * Known catalogue ids inspect here without installing: the whole package
 * must equal the shipped pin and every interior pin must agree, otherwise
 * the session is rejected and never falls back to unknown. Unknown
 * packages must be data-only schema v1 with exactly one `.litertlm`.
 *
 * This file has no Android framework dependencies so it runs as JVM
 * unit tests; SAF stream opening and free-space reading stay with the
 * `LocalVlmPlugin` bridge.
 */
class PackageInspectionStore(
    private val root: File,
    private val clockMs: () -> Long = System::currentTimeMillis
) {

    companion object {
        /** Stale inspection sessions expire after 30 minutes. */
        const val INSPECTION_TTL_MS = 30L * 60L * 1000L

        /** Unknown packages are small single-artifact data-only bundles. */
        const val MAX_UNKNOWN_MEMBERS = 16
    }

    data class InspectedPackage(
        val id: String,
        val manifest: PackageHost.Manifest,
        val packageSha256: String,
        val unknown: Boolean,
        val sandbox: File,
        val packageFile: File,
        val createdAtMs: Long = System.currentTimeMillis(),
        @Volatile var lastProbe: ProbeResult? = null,
        @Volatile var probedRole: String? = null
    )

    private val sessions = mutableMapOf<String, InspectedPackage>()

    fun get(id: String): InspectedPackage? {
        if (!isSessionId(id)) return null
        synchronized(sessions) {
            val current = sessions[id] ?: return null
            if (isExpired(current, clockMs())) {
                sessions.remove(id)
                File(root, "staging/${current.id}").deleteRecursively()
                return null
            }
            return current
        }
    }

    fun discard(id: String) {
        if (!isSessionId(id)) return
        val removed = synchronized(sessions) { sessions.remove(id) }
        removed?.let { File(root, "staging/${it.id}").deleteRecursively() }
    }

    fun pruneExpired(nowMs: Long = clockMs()) {
        val expired = synchronized(sessions) { sessions.values.filter { isExpired(it, nowMs) } }
        for (session in expired) discard(session.id)
    }

    fun recordProbe(id: String, probe: ProbeResult, role: String): Boolean {
        val session = get(id) ?: return false
        session.lastProbe = probe
        session.probedRole = role
        return true
    }

    private fun isExpired(session: InspectedPackage, nowMs: Long): Boolean =
        nowMs - session.createdAtMs > INSPECTION_TTL_MS

    /**
     * Validates [source] without installing. Returns the inspected
     * session, or null when the package is unreadable, violates the
     * data-only invariants, exceeds [freeBytes] or the expanded-size
     * cap, claims a known catalogue id without matching its exact
     * shipped pins, or (for unknown) is not a single-`.litertlm`
     * schema-v1 bundle.
     */
    fun inspect(source: InputStream, freeBytes: Long? = null): InspectedPackage? {
        pruneExpired()
        val id = UUID.randomUUID().toString()
        val sessionDir = File(root, "staging/$id")
        val staged = File(sessionDir, "package.fbmodel")
        val sandbox = File(sessionDir, "sandbox")
        try {
            sessionDir.mkdirs()
            val wholeDigest = MessageDigest.getInstance("SHA-256")
            var stagedBytes = 0L
            try {
                source.use { input ->
                    FileOutputStream(staged).use { out ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read == -1) break
                            stagedBytes += read
                            if (stagedBytes > PackageHost.MAX_EXPANDED_BYTES + PackageHost.MAX_MANIFEST_BYTES) return null
                            wholeDigest.update(buffer, 0, read)
                            out.write(buffer, 0, read)
                        }
                    }
                }
            } catch (_: Exception) {
                return null
            }
            val packageSha256 = wholeDigest.digest().joinToString("") { "%02x".format(it) }

            val manifest = PackageHost.peekManifest(staged) ?: return null
            val known = KnownPackageIdentity.forCatalogueId(manifest.entryId)
            val unknown: Boolean
            if (known != null) {
                // Known branch: exact shipped package plus interior pins.
                // Any mismatch rejects — never falls back to unknown.
                if (!packageSha256.equals(known.packageSha256, ignoreCase = true)) return null
                if (!interiorMatchesKnown(manifest, known)) return null
                unknown = false
            } else {
                if (!isStrictUnknownManifest(manifest)) return null
                unknown = true
            }

            if (!verifyMembers(staged, manifest, sandbox, freeBytes)) return null

            val inspected = InspectedPackage(
                id = id,
                manifest = manifest,
                packageSha256 = packageSha256,
                unknown = unknown,
                sandbox = sandbox,
                packageFile = staged,
                createdAtMs = clockMs()
            )
            synchronized(sessions) { sessions[id] = inspected }
            return inspected
        } catch (_: Exception) {
            return null
        } finally {
            // On any failure the session directory (staging + sandbox)
            // is removed; nothing is ever promoted to the library here.
            val keep = synchronized(sessions) { sessions.containsKey(id) }
            if (!keep) sessionDir.deleteRecursively()
        }
    }

    private fun isSessionId(id: String): Boolean {
        return try {
            UUID.fromString(id)
            true
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    private fun interiorMatchesKnown(manifest: PackageHost.Manifest, known: KnownPackageIdentity): Boolean {
        val specs = known.manifest.files
        if (manifest.files.size != specs.size) return false
        for (spec in specs) {
            val base = spec.path.substringAfterLast('/')
            val matches = manifest.files.filter { it.path.substringAfterLast('/') == base }
            if (matches.size != 1) return false
            val candidate = matches.single()
            if (candidate.bytes != spec.expectedBytes) return false
            if (!candidate.sha256.equals(spec.sha256, ignoreCase = true)) return false
        }
        return true
    }

    private fun isStrictUnknownManifest(manifest: PackageHost.Manifest): Boolean {
        if (manifest.files.isEmpty() || manifest.files.size > MAX_UNKNOWN_MEMBERS) return false
        val litertlm = manifest.files.filter { it.path.lowercase().endsWith(".litertlm") }
        if (litertlm.size != 1) return false
        for (file in manifest.files) {
            if (file.bytes <= 0 || file.bytes > PackageHost.MAX_EXPANDED_BYTES) return false
            if (file.sha256.isBlank()) return false
        }
        return true
    }

    private fun verifyMembers(
        staged: File,
        manifest: PackageHost.Manifest,
        sandbox: File,
        freeBytes: Long?
    ): Boolean {
        try {
            ZipFile(staged).use { archive ->
                val symlinkNames = PackageHost.centralDirSymlinkNames(staged) ?: return false
                val entries = archive.entries().asSequence().toList()
                for (file in manifest.files) {
                    val unsafe = PackageHost.findUnsafePathReason(file.path)
                    if (unsafe != null) return false
                    if (PackageHost.isDeniedSuffix(file.path)) return false
                }
                val byName = entries.filter { !it.isDirectory }.associateBy { it.name }
                for (listed in manifest.files) {
                    val present = byName[listed.path] ?: return false
                    if (symlinkNames.contains(listed.path)) return false
                    if (present.isDirectory) return false
                }
                val manifestPaths = manifest.files.map { it.path }.toSet()
                for (candidate in entries) {
                    val name = candidate.name
                    if (name == PackageHost.MANIFEST_NAME) continue
                    if (candidate.isDirectory) {
                        if (PackageHost.findUnsafePathReason(name.trimEnd('/')) != null) return false
                        continue
                    }
                    if (symlinkNames.contains(name)) return false
                    if (PackageHost.findUnsafePathReason(name) != null) return false
                    if (!manifestPaths.contains(name)) return false
                }

                val declaredTotal = manifest.files.sumOf { it.bytes }
                if (declaredTotal > PackageHost.MAX_EXPANDED_BYTES) return false
                if (freeBytes != null && declaredTotal > freeBytes) return false

                sandbox.mkdirs()
                val sandboxCanonical = sandbox.canonicalPath
                var expandedTotal = 0L
                for (file in manifest.files) {
                    val zipEntry = byName[file.path] ?: return false
                    val target = File(sandbox, file.path)
                    if (!target.canonicalPath.startsWith(sandboxCanonical + File.separator)) return false
                    target.parentFile?.mkdirs()
                    val fileDigest = MessageDigest.getInstance("SHA-256")
                    val head = ByteArray(4)
                    var headFilled = 0
                    var actualBytes = 0L
                    try {
                        archive.getInputStream(zipEntry).use { input ->
                            FileOutputStream(target).use { out ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) {
                                    val read = input.read(buffer)
                                    if (read == -1) break
                                    actualBytes += read
                                    if (actualBytes > file.bytes) return false
                                    expandedTotal += read
                                    if (expandedTotal > PackageHost.MAX_EXPANDED_BYTES) return false
                                    fileDigest.update(buffer, 0, read)
                                    if (headFilled < 4) {
                                        val copyCount = minOf(4 - headFilled, read)
                                        System.arraycopy(buffer, 0, head, headFilled, copyCount)
                                        headFilled += copyCount
                                    }
                                    out.write(buffer, 0, read)
                                }
                            }
                        }
                    } catch (_: Exception) {
                        return false
                    }
                    if (actualBytes != file.bytes) return false
                    if (PackageHost.hasDeniedMagic(head, headFilled)) return false
                    val fileHex = fileDigest.digest().joinToString("") { "%02x".format(it) }
                    if (!fileHex.equals(file.sha256, ignoreCase = true)) return false
                }
                return true
            }
        } catch (_: Exception) {
            return false
        }
    }
}
