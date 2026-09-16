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
     * Saves the state record for a model.
     */
    fun saveRecord(record: ModelStateRecord) {
        val file = stateFile(record.modelId)
        file.parentFile?.mkdirs()
        FileWriter(file).use { writer ->
            gson.toJson(record, writer)
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