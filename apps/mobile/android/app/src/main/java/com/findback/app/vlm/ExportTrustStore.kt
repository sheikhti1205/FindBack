package com.findback.app.vlm

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.reflect.TypeToken
import java.io.File

/**
 * Native-side trust tombstone for catalogue re-exports.
 *
 * Records, per catalogue entry id, the artifact hashes the native side
 * itself verified at download/verify time. Stored app-private at
 * `[storeRoot]/export-trust.json` (atomic temp + rename) — deliberately
 * outside any per-model directory so it survives catalogue-row deletion.
 * Inspection of a locally re-exported package accepts it IFF the declared
 * entry id is one of [SixModelCatalogue.ALL_SIX] AND every artifact hash
 * equals these tombstoned pins (or the shipped interior pins). The package
 * manifest's self-declaration alone is NEVER sufficient.
 *
 * No Android framework dependencies; runs as JVM unit tests.
 */
object ExportTrustStore {
    private val gson: Gson = GsonBuilder().create()

    private data class Entry(val entryId: String, val files: List<FilePin>)
    private data class FilePin(val path: String, val bytes: Long, val sha256: String)

    private fun trustFile(storeRoot: File): File = File(storeRoot, "export-trust.json")

    @Synchronized
    fun record(storeRoot: File, entryId: String, files: List<ModelFileSpec>) {
        require(SixModelCatalogue.isCatalogueId(entryId)) { "Not a catalogue entry id" }
        require(files.isNotEmpty()) { "Trusted pins must not be empty" }
        for (spec in files) {
            require(spec.expectedBytes > 0) { "Bad trusted pin bytes" }
            require(Regex("[0-9a-fA-F]{64}").matches(spec.sha256)) { "Bad trusted pin hash" }
        }
        val current = readAll(storeRoot).filter { it.entryId != entryId } +
            Entry(entryId, files.map { FilePin(it.path, it.expectedBytes, it.sha256.lowercase()) })
        writeAll(storeRoot, current)
    }

    /** Tombstoned pins, or null when this entry was never verified natively. */
    @Synchronized
    fun trustedFor(storeRoot: File, entryId: String): List<ModelFileSpec>? {
        if (!SixModelCatalogue.isCatalogueId(entryId)) return null
        val entry = readAll(storeRoot).singleOrNull { it.entryId == entryId } ?: return null
        if (entry.files.isEmpty()) return null
        return entry.files.map { ModelFileSpec(it.path, it.bytes, it.sha256) }
    }

    private fun readAll(storeRoot: File): List<Entry> {
        val file = trustFile(storeRoot)
        if (!file.isFile) return emptyList()
        return try {
            val type = object : TypeToken<List<Entry>>() {}.type
            gson.fromJson<List<Entry>>(file.readText(Charsets.UTF_8), type) ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun writeAll(storeRoot: File, entries: List<Entry>) {
        val file = trustFile(storeRoot)
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "export-trust.json.tmp")
        tmp.writeText(gson.toJson(entries), Charsets.UTF_8)
        if (file.exists() && !file.delete()) throw IllegalStateException("Failed to replace export trust store")
        if (!tmp.renameTo(file)) throw IllegalStateException("Failed to write export trust store")
    }
}
