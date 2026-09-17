package com.findback.app.vlm

import android.content.Context
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.io.File
import java.io.FileWriter
import java.io.FileReader

/**
 * Persistent model store for VLM models.
 * Manages model directories, partial downloads, and state persistence.
 */
class ModelStore(val root: File) {

    private val gson: Gson = GsonBuilder().create()

    /**
     * Creates a ModelStore using the app's files directory.
     */
    companion object {
        fun create(context: Context): ModelStore {
            val rootDir = File(context.filesDir, "findback-models")
            return ModelStore(rootDir)
        }
    }

    /**
     * Returns the directory for a specific model manifest (modelId/revision).
     */
    fun dirFor(manifest: ModelManifest): File {
        return File(root, "${manifest.id}/${manifest.revision}")
    }

    /**
     * Returns the partial (.part) file for a specific model file.
     */
    fun partFile(manifest: ModelManifest, spec: ModelFileSpec): File {
        return File(dirFor(manifest), "${spec.path}.part")
    }

    /**
     * Returns the final file for a specific model file.
     */
    fun finalFile(manifest: ModelManifest, spec: ModelFileSpec): File {
        return File(dirFor(manifest), spec.path)
    }

    /**
     * Returns the transfer journal (.journal.json) file for a model file.
     * Journal writes are atomic (temp + rename); never treated as installed.
     */
    fun journalFile(manifest: ModelManifest, spec: ModelFileSpec): File {
        return File(dirFor(manifest), "${spec.path}.journal.json")
    }

    /**
     * Returns the per-chunk temp (.chunk.tmp) file for a model file.
     * Each chunk streams here first, is hashed, and only then is written
     * at its exact offset in the `.part` file.
     */
    fun chunkTmpFile(manifest: ModelManifest, spec: ModelFileSpec): File {
        return File(dirFor(manifest), "${spec.path}.chunk.tmp")
    }

    /**
     * Returns the state file for a model ID.
     */
    private fun stateFile(modelId: VlmModelId): File {
        return File(root, "${modelId.wire}/state.json")
    }

    /**
     * Loads the persisted state record for a model.
     */
    fun loadRecord(modelId: VlmModelId): ModelStateRecord? {
        val file = stateFile(modelId)
        if (!file.exists()) return null
        return try {
            FileReader(file).use { reader ->
                gson.fromJson(reader, ModelStateRecord::class.java)
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Saves the state record for a model (atomic temp + rename).
     */
    fun saveRecord(record: ModelStateRecord) {
        val file = stateFile(record.modelId)
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        FileWriter(tmp).use { writer ->
            gson.toJson(record, writer)
        }
        if (file.exists() && !file.delete()) {
            throw IllegalStateException("Failed to replace state file: ${file.absolutePath}")
        }
        if (!tmp.renameTo(file)) {
            throw IllegalStateException("Failed to atomically write state file: ${file.absolutePath}")
        }
    }

    /**
     * Persists a transfer-state record (QUEUED/DOWNLOADING/VERIFYING/terminal).
     * Keeps one model unaffected by another: only this manifest's model ID is
     * touched. Installed byte counts prefer final files, then verified journal
     * bytes — never the preallocated `.part` length. The installed SHA is
     * carried only when a complete final file exists; otherwise it stays empty
     * until whole-file verification passes.
     */
    fun saveTransferRecord(
        manifest: ModelManifest,
        state: VlmState,
        error: String? = null,
        modelId: VlmModelId = VlmModelId.fromWire(manifest.id) ?: VlmModelId.SMOLVLM2_500M
    ) {
        val previous = loadRecord(modelId)
        val files = manifest.files.map { spec ->
            val finalFile = finalFile(manifest, spec)
            if (finalFile.exists() && finalFile.length() == spec.expectedBytes) {
                InstalledFileRecord(
                    path = spec.path,
                    expectedBytes = spec.expectedBytes,
                    installedBytes = finalFile.length(),
                    expectedSha256 = spec.sha256,
                    installedSha256 = previous?.files?.singleOrNull { it.path == spec.path }?.installedSha256 ?: ""
                )
            } else {
                val journal = TransferJournalStore.load(journalFile(manifest, spec))
                InstalledFileRecord(
                    path = spec.path,
                    expectedBytes = spec.expectedBytes,
                    installedBytes = TransferJournalStore.verifiedBytes(spec.expectedBytes, journal),
                    expectedSha256 = spec.sha256,
                    installedSha256 = ""
                )
            }
        }
        saveRecord(
            ModelStateRecord(
                modelId = modelId,
                state = state,
                files = files,
                installedBytes = files.sumOf { it.installedBytes },
                installTimestamp = previous?.installTimestamp ?: System.currentTimeMillis(),
                runtimeVersion = manifest.runtime,
                appVersion = previous?.appVersion ?: "1.0",
                fingerprint = previous?.fingerprint ?: (android.os.Build.FINGERPRINT ?: "unknown"),
                abi = previous?.abi ?: (android.os.Build.SUPPORTED_ABIS?.firstOrNull() ?: "unknown"),
                gpuVendor = previous?.gpuVendor,
                gpuRenderer = previous?.gpuRenderer,
                revision = manifest.revision,
                sha256 = files.joinToString("") { it.expectedSha256 },
                lastGpuSelfTest = previous?.lastGpuSelfTest,
                lastError = error?.let { ModelError(VlmErrorCode.DOWNLOAD_FAILED, it) } ?: previous?.lastError
            )
        )
    }

    /**
     * Promotes a verified `.part` file to its final name. The part must
     * already have passed whole-file verification (size + SHA) — verified
     * again here as a final gate. Uses an atomic move with REPLACE_EXISTING;
     * the fallback quarantines an invalid final aside first and never deletes
     * a good final before the verified replacement is in place.
     *
     * @return true when the final file is the verified content.
     */
    fun promotePartToFinal(manifest: ModelManifest, spec: ModelFileSpec): Boolean {
        val part = partFile(manifest, spec)
        val final = finalFile(manifest, spec)
        if (!part.exists() || part.length() != spec.expectedBytes) return false
        if (!Sha256.matchesFile(part, spec.sha256)) return false
        final.parentFile?.mkdirs()
        return try {
            java.nio.file.Files.move(
                part.toPath(),
                final.toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                java.nio.file.StandardCopyOption.ATOMIC_MOVE
            )
            true
        } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
            moveWithQuarantineFallback(part, final, spec)
        } catch (e: java.io.IOException) {
            moveWithQuarantineFallback(part, final, spec)
        }
    }

    private fun moveWithQuarantineFallback(part: File, final: File, spec: ModelFileSpec): Boolean {
        if (final.exists() && !isValidFinal(final, spec)) {
            quarantineInvalidFinal(final)
        }
        return try {
            java.nio.file.Files.move(
                part.toPath(),
                final.toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING
            )
            isValidFinal(final, spec)
        } catch (e: java.io.IOException) {
            false
        }
    }

    private fun isValidFinal(final: File, spec: ModelFileSpec): Boolean {
        return final.exists() &&
            final.length() == spec.expectedBytes &&
            Sha256.matchesFile(final, spec.sha256)
    }

    /**
     * Moves an invalid final file aside for diagnosis instead of deleting it
     * outright. A good final is never quarantined.
     */
    fun quarantineInvalidFinal(final: File): File? {
        if (!final.exists()) return null
        val backup = File(final.parentFile, "${final.name}.corrupt-${System.currentTimeMillis()}.bak")
        return try {
            java.nio.file.Files.move(
                final.toPath(),
                backup.toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING
            )
            backup
        } catch (e: java.io.IOException) {
            null
        }
    }

    /**
     * Deletes all files for a specific model ID, preserving other models.
     */
    fun deleteModel(modelId: VlmModelId) {
        val modelDir = File(root, modelId.wire)
        if (modelDir.exists()) {
            deleteRecursively(modelDir)
        }
    }

    private fun deleteRecursively(file: File) {
        if (file.isDirectory) {
            file.listFiles()?.forEach { deleteRecursively(it) }
        }
        file.delete()
    }
}