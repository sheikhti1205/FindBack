package com.findback.app.vlm

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import com.google.gson.reflect.TypeToken
import java.io.File

/**
 * Persistent app-private registry for user-imported (unknown) models.
 *
 * Identity is namespaced by the full package SHA-256 — never the
 * manifest-declared entry id — so a malicious manifest id can never
 * collide with (or impersonate) another entry. Unknown entries never
 * auto-activate: activation stays with the explicit runtime paths.
 *
 * Storage: `[storeRoot]/imported/registry.json` (atomic temp + rename).
 * Installed bytes live at `[storeRoot]/imported/<sha256>/…`.
 * No Android framework dependencies; runs as JVM unit tests.
 */
object ImportedModelRegistry {
    const val STATE_READY = "READY"
    const val STATE_NOT_VERIFIED = "NOT_VERIFIED"

    data class Record(
        val entryId: String,
        val label: String,
        val description: String? = null,
        val role: String,
        val state: String,
        val bytes: Long,
        val error: String? = null,
        val loadMs: Long? = null,
        val inferenceMs: Long? = null,
        val memoryBeforeMb: Long? = null,
        val observedPeakMb: Long? = null,
        val packageSha256: String,
        val manifestEntryId: String,
        val createdAt: Long = System.currentTimeMillis()
    )

    private val gson: Gson = GsonBuilder().create()

    fun dirFor(storeRoot: File, entryId: String): File {
        require(ImportCommitPolicy.isNamespacedEntryId(entryId)) { "Unsafe imported entry id" }
        return File(File(storeRoot, "imported"), entryId)
    }

    private fun registryFile(storeRoot: File): File = File(File(storeRoot, "imported"), "registry.json")

    @Synchronized
    fun list(storeRoot: File): List<Record> {
        val file = registryFile(storeRoot)
        if (!file.isFile) return emptyList()
        return try {
            val type = object : TypeToken<List<Record>>() {}.type
            gson.fromJson<List<Record>>(file.readText(Charsets.UTF_8), type) ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
    }

    @Synchronized
    fun upsert(storeRoot: File, record: Record) {
        require(ImportCommitPolicy.isNamespacedEntryId(record.entryId)) { "Unsafe imported entry id" }
        require(record.entryId == record.packageSha256.lowercase()) { "Imported identity must equal the package SHA-256" }
        val current = list(storeRoot).filter { it.entryId != record.entryId } + record
        writeAll(storeRoot, current.sortedBy { it.createdAt })
    }

    data class DeleteResult(
        val ok: Boolean,
        val code: String? = null,
        val reason: String? = null
    )

    @Synchronized
    fun remove(storeRoot: File, entryId: String): Boolean {
        return try {
            removeWithResult(storeRoot, entryId).ok
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Deletes exactly one imported entry, files first. The entry directory
     * is removed and its removal verified BEFORE the registry is updated —
     * a deletion failure returns an error with the registry left intact.
     * [deleteOp] performs the directory removal (injectable for tests);
     * removal counts only when it returns true AND the directory is gone.
     */
    @Synchronized
    fun removeWithResult(
        storeRoot: File,
        entryId: String,
        deleteOp: (File) -> Boolean = { dir -> dir.deleteRecursively() }
    ): DeleteResult {
        if (!ImportCommitPolicy.isNamespacedEntryId(entryId)) {
            return DeleteResult(false, PackageHost.Code.ENTRY_MISMATCH, "Imported model not found")
        }
        val current = list(storeRoot)
        if (current.none { it.entryId == entryId }) {
            return DeleteResult(false, PackageHost.Code.ENTRY_MISMATCH, "Imported model not found")
        }
        // Files FIRST, verify removal, THEN the registry write.
        val dir = File(File(storeRoot, "imported"), entryId)
        if (dir.exists()) {
            val removed = try {
                deleteOp(dir)
            } catch (_: Exception) {
                false
            }
            if (!removed || dir.exists()) {
                return DeleteResult(false, "DELETE_FAILED", "Could not delete model files; the registry is unchanged.")
            }
        }
        return try {
            writeAll(storeRoot, current.filter { it.entryId != entryId })
            DeleteResult(true)
        } catch (e: Exception) {
            DeleteResult(false, PackageHost.Code.CORRUPT_ARCHIVE, "Could not update the imported registry: ${e.message}")
        }
    }

    private fun writeAll(storeRoot: File, records: List<Record>) {
        val file = registryFile(storeRoot)
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "registry.json.tmp")
        tmp.writeText(gson.toJson(records), Charsets.UTF_8)
        if (file.exists() && !file.delete()) throw IllegalStateException("Failed to replace imported registry")
        if (!tmp.renameTo(file)) throw IllegalStateException("Failed to write imported registry")
    }

    /** Installed payload bytes, excluding registry/provenance envelopes. */
    fun installedBytes(entryDir: File): Long {
        if (!entryDir.isDirectory) return 0L
        return entryDir.walkTopDown().filter { it.isFile && it.name != "provenance.json" && it.name != "imported.json" }
            .sumOf { it.length() }
    }

    /** Export only the inspected weight recorded in app-private provenance. */
    fun verifiedExportFiles(storeRoot: File, entryId: String): List<ModelFileSpec>? {
        if (!ImportCommitPolicy.isNamespacedEntryId(entryId) ||
            list(storeRoot).none { it.entryId == entryId && it.packageSha256 == entryId }) return null
        val dir = dirFor(storeRoot, entryId)
        return try {
            val provenance = JsonParser.parseString(File(dir, "provenance.json").readText(Charsets.UTF_8)).asJsonObject
            if (provenance.get("entryId").asString != entryId ||
                provenance.get("packageSha256").asString != entryId) return null
            val weights = provenance.getAsJsonArray("files").mapNotNull { element ->
                val file = element.asJsonObject
                val path = file.get("path").asString
                if (!path.startsWith("weights/") || !path.endsWith(".litertlm")) return@mapNotNull null
                val bytes = file.get("bytes").asLong
                val hash = file.get("sha256").asString
                if (PackageHost.findUnsafePathReason(path) != null || bytes <= 0 ||
                    bytes > PackageHost.MAX_EXPANDED_BYTES || !Regex("[0-9a-f]{64}").matches(hash)) return null
                ModelFileSpec(path, bytes, hash)
            }
            if (weights.size != 1) return null
            val spec = weights.single()
            val file = File(dir, spec.path)
            if (!file.isFile || !file.canonicalPath.startsWith(dir.canonicalPath + File.separator) ||
                file.length() != spec.expectedBytes || !Sha256.matchesFile(file, spec.sha256)) return null
            weights
        } catch (_: Exception) { null }
    }
}
