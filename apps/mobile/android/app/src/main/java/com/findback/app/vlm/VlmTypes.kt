package com.findback.app.vlm

import com.getcapacitor.JSObject
import java.util.concurrent.ConcurrentHashMap

/**
 * VLM model identifiers with their wire-format strings.
 */
enum class VlmModelId(val wire: String) {
    SMOLVLM_256M("smolvlm-256m"),
    SMOLVLM2_500M("smolvlm2-500m"),
    SMOLVLM2_2B("smolvlm2-2b"),
    GEMMA_3N_2B("gemma-3n-2b"),
    GEMMA_3N_4B("gemma-3n-4b");

    companion object {
        fun fromWire(wire: String): VlmModelId? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * VLM inference mode.
 */
enum class VlmMode(val wire: String) {
    AUTO("AUTO"),
    QUALITY("QUALITY"),
    SPEED("SPEED");

    companion object {
        fun fromWire(wire: String): VlmMode? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * VLM backend type.
 */
enum class VlmBackend(val wire: String) {
    CPU("cpu"),
    GPU("gpu");

    companion object {
        fun fromWire(wire: String): VlmBackend? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * Model state.
 */
enum class VlmModelState(val wire: String) {
    NOT_DOWNLOADED("NOT_DOWNLOADED"),
    DOWNLOADING("DOWNLOADING"),
    READY_CPU("READY_CPU"),
    READY_GPU("READY_GPU"),
    ERROR("ERROR");

    companion object {
        fun fromWire(wire: String): VlmModelState? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * GPU self-test state.
 */
enum class GpuSelfTestState(val wire: String) {
    GPU_AVAILABLE("GPU_AVAILABLE"),
    GPU_UNAVAILABLE("GPU_UNAVAILABLE"),
    GPU_UNSUPPORTED("GPU_UNSUPPORTED"),
    ERROR("ERROR");

    companion object {
        fun fromWire(wire: String): GpuSelfTestState? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * Device category.
 */
enum class DeviceCategory(val wire: String) {
    PHYSICAL("physical"),
    EMULATOR("emulator"),
    WEB("web");

    companion object {
        fun fromWire(wire: String): DeviceCategory? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * Capabilities reported by the native plugin.
 */
data class VlmCapabilities(
    val abi: String,
    val androidVersion: String,
    val apiLevel: Int,
    val hardware: String,
    val deviceCategory: DeviceCategory,
    val gpuVendor: String?,
    val gpuRenderer: String?,
    val memoryClassMb: Int,
    val freeAppStorageMb: Long,
    val gpuRuntimePresent: Boolean,
    val runtimeVersion: String?
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("abi", abi)
        obj.put("androidVersion", androidVersion)
        obj.put("apiLevel", apiLevel)
        obj.put("hardware", hardware)
        obj.put("deviceCategory", deviceCategory.wire)
        obj.put("gpuVendor", gpuVendor)
        obj.put("gpuRenderer", gpuRenderer)
        obj.put("memoryClassMb", memoryClassMb)
        obj.put("freeAppStorageMb", freeAppStorageMb)
        obj.put("gpuRuntimePresent", gpuRuntimePresent)
        obj.put("runtimeVersion", runtimeVersion)
        return obj
    }
}

/**
 * Model state info.
 */
data class VlmModelInfo(
    val id: VlmModelId,
    val state: VlmModelState,
    val sizeBytes: Long? = null,
    val error: String? = null
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("id", id.wire)
        obj.put("state", state.wire)
        sizeBytes?.let { obj.put("sizeBytes", it) }
        error?.let { obj.put("error", it) }
        return obj
    }
}

/**
 * Settings.
 */
data class VlmSettings(
    val mode: VlmMode
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("mode", mode.wire)
        return obj
    }
}

/**
 * Inference state event.
 */
data class InferenceStateEvent(
    val modelId: VlmModelId,
    val state: VlmModelState,
    val progress: Float? = null,
    val error: String? = null
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("modelId", modelId.wire)
        obj.put("state", state.wire)
        progress?.let { obj.put("progress", it) }
        error?.let { obj.put("error", it) }
        return obj
    }
}

/**
 * Download progress event.
 */
data class DownloadProgressEvent(
    val modelId: VlmModelId,
    val progress: Float,
    val downloadedBytes: Long,
    val totalBytes: Long
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("modelId", modelId.wire)
        obj.put("progress", progress)
        obj.put("downloadedBytes", downloadedBytes)
        obj.put("totalBytes", totalBytes)
        return obj
    }
}

/**
 * Analyze image result.
 */
data class AnalyzeImageResult(
    val text: String,
    val modelId: VlmModelId,
    val backend: VlmBackend,
    val runtime: String,
    val diagnostics: List<String>
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("text", text)
        obj.put("modelId", modelId.wire)
        obj.put("backend", backend.wire)
        obj.put("runtime", runtime)
        obj.put("diagnostics", diagnostics)
        return obj
    }
}

/**
 * Embed texts result.
 */
data class EmbedTextsResult(
    val vectors: List<List<Float>>
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("vectors", vectors.map { it.toTypedArray() }.toTypedArray())
        return obj
    }
}

/**
 * GPU self-test result.
 */
data class GpuSelfTestResult(
    val state: GpuSelfTestState,
    val error: String? = null
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("state", state.wire)
        error?.let { obj.put("error", it) }
        return obj
    }
}