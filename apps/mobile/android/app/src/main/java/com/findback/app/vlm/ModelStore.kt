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
     * touched. Installed byte counts prefer final files, then partials.
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
            val part = partFile(manifest, spec)
            val installedBytes = when {
                finalFile.exists() -> finalFile.length()
                part.exists() -> part.length()
                else -> 0L
            }
            InstalledFileRecord(
                path = spec.path,
                expectedBytes = spec.expectedBytes,
                installedBytes = installedBytes,
                expectedSha256 = spec.sha256,
                installedSha256 = previous?.files?.singleOrNull { it.path == spec.path }?.installedSha256 ?: spec.sha256
            )
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