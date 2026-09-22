package com.findback.app.vlm

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import java.io.File

/**
 * Entry-keyed transfer-state record for the text runtime
 * (`root/<entryId>/text-state.json`). Deliberately not
 * `root/<wire>/state.json`: `VlmModelId` stays exactly the two image
 * ids and image `getModelStates` never leaks a text row.
 *
 * Storage mechanics only: the caller chooses every value, including
 * [state] (`INSTALLED_UNVERIFIED` means transfer-verified size + SHA
 * at promotion, never GPU-tested). This layer only persists them
 * atomically and returns null for missing or corrupt records.
 */
data class TextTransferState(
    val entryId: String,
    val revision: String,
    val state: VlmState,
    val installedBytes: Long,
    val installedSha256: String,
    val installTimestamp: Long,
    val lastError: String? = null
)

/**
 * Atomic persistence for [TextTransferState] (temp + rename, same
 * discipline as [ModelStore.saveRecord]). Reads never throw and never
 * re-hash: the hash is asserted once at promotion and carried here.
 */
object TextTransferStateStore {

    const val FILE_NAME = "text-state.json"

    private val gson = GsonBuilder().create()

    /**
     * True when [entryId] cannot address exactly one entry dir:
     * anything but a single safe path segment (nested paths would
     * break the entry-prefix invariant delete-exactness relies on).
     */
    fun isUnsafeEntryId(entryId: String): Boolean =
        entryId.contains('/') || PackageHost.findUnsafePathReason(entryId) != null

    fun fileFor(storeRoot: File, entryId: String): File {
        if (isUnsafeEntryId(entryId)) {
            throw IllegalArgumentException("Unsafe entry id: $entryId")
        }
        return File(File(storeRoot, entryId), FILE_NAME)
    }

    /**
     * Loads the record, or null when missing or corrupt.
     */
    fun load(file: File): TextTransferState? {
        if (!file.exists()) return null
        return try {
            deserialize(file.readText())
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Atomically writes the record (temp file + rename).
     */
    fun saveAtomic(file: File, state: TextTransferState) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(serialize(state))
        if (file.exists() && !file.delete()) {
            throw IllegalStateException("Failed to replace text-state file: ${file.absolutePath}")
        }
        if (!tmp.renameTo(file)) {
            throw IllegalStateException("Failed to atomically write text-state file: ${file.absolutePath}")
        }
    }

    private fun serialize(state: TextTransferState): String {
        val entries = linkedMapOf<String, Any?>(
            "entryId" to state.entryId,
            "revision" to state.revision,
            "state" to state.state.wire,
            "installedBytes" to state.installedBytes,
            "installTimestamp" to state.installTimestamp,
            "installedSha256" to state.installedSha256
        )
        if (state.lastError != null) entries["lastError"] = state.lastError
        return gson.toJson(entries)
    }

    private fun deserialize(json: String): TextTransferState? {
        val root = try {
            JsonParser.parseString(json)
        } catch (e: Exception) {
            return null
        }
        if (!root.isJsonObject) return null
        val obj = root.asJsonObject
        fun stringField(name: String): String? {
            val element = obj.get(name) ?: return null
            if (!element.isJsonPrimitive || !element.asJsonPrimitive.isString) return null
            return element.asString
        }
        fun longField(name: String): Long? {
            return try {
                obj.get(name)?.asLong
            } catch (e: Exception) {
                null
            }
        }
        val entryId = stringField("entryId") ?: return null
        val revision = stringField("revision") ?: return null
        val state = VlmState.fromWire(stringField("state") ?: return null) ?: return null
        val installedBytes = longField("installedBytes") ?: return null
        val installTimestamp = longField("installTimestamp") ?: return null
        val installedSha256 = stringField("installedSha256") ?: return null
        val lastError = if (obj.has("lastError")) stringField("lastError") else null
        if (obj.has("lastError") && obj.get("lastError") != null &&
            !obj.get("lastError").isJsonNull && lastError == null
        ) return null
        return TextTransferState(
            entryId = entryId,
            revision = revision,
            state = state,
            installedBytes = installedBytes,
            installedSha256 = installedSha256,
            installTimestamp = installTimestamp,
            lastError = lastError
        )
    }
}
