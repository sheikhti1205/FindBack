package com.findback.app.ai

import com.google.ai.edge.litertlm.ModelInfo
import com.google.ai.edge.litertlm.BackendType
import com.google.ai.edge.litertlm.Modality

/** Metadata is a runtime gate, never qualification or a filename-based trust upgrade. */
object LiteRtArtifactPolicy {
    fun inspect(path: String, modelId: String, vision: Boolean) {
        ModelInfo.from(path).use { info ->
            require(info is ModelInfo.Llm) { "Unsupported model type" }
            val min = info.minRuntimeVersion()
            if (min == null && modelId.startsWith("imported-")) throw IllegalArgumentException("Unknown minimum runtime")
            if (min != null) {
                val parts = min.removePrefix("v").split('.').map { it.toIntOrNull() ?: throw IllegalArgumentException("Invalid runtime version") }
                require(parts.size == 3 && (parts[0] < 0 || (parts[0] == 0 && (parts[1] < 18 || (parts[1] == 18 && parts[2] == 0))))) { "Runtime too old" }
            }
            require(info.inputModalities().text && (!vision || info.inputModalities().vision)) { "Unsupported input modality" }
            require(info.supportedBackends(Modality.TEXT).contains(BackendType.CPU)) { "CPU text executor unavailable" }
            if (vision) require(info.supportedBackends(Modality.VISION).contains(BackendType.CPU)) { "CPU vision executor unavailable" }
            require(info.maxContextTokens() >= 512) { "Context too small" }
        }
    }
}
