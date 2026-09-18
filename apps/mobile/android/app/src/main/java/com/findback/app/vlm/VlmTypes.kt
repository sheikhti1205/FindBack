package com.findback.app.vlm

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

/**
 * VLM model identifiers with their wire-format strings.
 * Exactly two models as per Locked Interfaces.
 */
enum class VlmModelId(val wire: String) {
    SMOLVLM2_500M("smolvlm2-500m"),
    SMOLVLM_256M("smolvlm-256m");

    companion object {
        fun fromWire(wire: String): VlmModelId? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * VLM inference backend mode.
 * FAST instead of SPEED as per Locked Interfaces.
 */
enum class BackendMode(val wire: String) {
    AUTO("AUTO"),
    FAST("FAST"),
    QUALITY("QUALITY");

    companion object {
        fun fromWire(wire: String): BackendMode? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * VLM model state.
 * No CPU state, includes all required states as per Locked Interfaces.
 */
enum class VlmState(val wire: String) {
    NOT_INSTALLED("NOT_INSTALLED"),
    QUEUED("QUEUED"),
    WAITING_FOR_NETWORK("WAITING_FOR_NETWORK"),
    WAITING_FOR_WIFI("WAITING_FOR_WIFI"),
    DOWNLOADING("DOWNLOADING"),
    PAUSING("PAUSING"),
    PAUSED("PAUSED"),
    PAUSED_ERROR("PAUSED_ERROR"),
    VERIFYING_CHUNK("VERIFYING_CHUNK"),
    VERIFYING_HASH("VERIFYING_HASH"),
    VERIFYING_FILE("VERIFYING_FILE"),
    REPAIR_NEEDED("REPAIR_NEEDED"),
    REPAIRING("REPAIRING"),
    MANIFEST_MISMATCH("MANIFEST_MISMATCH"),
    INSTALLED_UNVERIFIED("INSTALLED_UNVERIFIED"),
    GPU_SELF_TESTING("GPU_SELF_TESTING"),
    READY_GPU("READY_GPU"),
    GPU_UNAVAILABLE("GPU_UNAVAILABLE"),
    CORRUPT("CORRUPT"),
    INSUFFICIENT_STORAGE("INSUFFICIENT_STORAGE"),
    DOWNLOAD_FAILED("DOWNLOAD_FAILED"),
    RUNTIME_ERROR("RUNTIME_ERROR");

    companion object {
        fun fromWire(wire: String): VlmState? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * VLM error codes.
 */
enum class VlmErrorCode(val wire: String) {
    GPU_UNAVAILABLE_ON_CURRENT_RUNTIME("GPU_UNAVAILABLE_ON_CURRENT_RUNTIME"),
    DOWNLOAD_FAILED("DOWNLOAD_FAILED"),
    HASH_MISMATCH("HASH_MISMATCH"),
    INSUFFICIENT_STORAGE("INSUFFICIENT_STORAGE"),
    RUNTIME_ERROR("RUNTIME_ERROR");

    companion object {
        fun fromWire(wire: String): VlmErrorCode? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * Specification for a model file.
 *
 * [path] is the local on-device storage name. [remotePath] is the exact
 * filename on the pinned Hugging Face revision; it defaults to [path] but
 * MUST differ when the upstream filename does not match (e.g. the 256M
 * TFLite, whose upstream file contains the typo `smalvlm`). Download URLs
 * are built from [remotePath] so a spelling mismatch can never 404 on device.
 */
data class ModelFileSpec(
    val path: String,
    val expectedBytes: Long,
    val sha256: String,
    val remotePath: String = path
)

/**
 * A model manifest with pinned revision, source repo, and file list.
 */
data class ModelManifest(
    val id: String,
    val sourceRepo: String,
    val revision: String,
    val files: List<ModelFileSpec>,
    val runtime: String
)

/**
 * Model error with code and message.
 */
data class ModelError(
    val code: VlmErrorCode,
    val message: String
)

/**
 * Record of an installed file with expected and actual values.
 */
data class InstalledFileRecord(
    val path: String,
    val expectedBytes: Long,
    val installedBytes: Long,
    val expectedSha256: String,
    val installedSha256: String
)

/**
 * Record of model state for persistence.
 */
data class ModelStateRecord(
    val modelId: VlmModelId,
    val state: VlmState,
    val files: List<InstalledFileRecord>,
    val installedBytes: Long,
    val installTimestamp: Long,
    val runtimeVersion: String,
    val appVersion: String,
    val fingerprint: String,
    val abi: String,
    val gpuVendor: String?,
    val gpuRenderer: String?,
    val revision: String,
    val sha256: String,
    val lastGpuSelfTest: Long?,
    val lastError: ModelError?
)

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
 * Expanded device info kept as the plugin needs it.
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
 * Settings.
 */
data class VlmSettings(
    val mode: BackendMode
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("mode", mode.wire)
        return obj
    }
}

/**
 * Analyze request.
 */
data class AnalyzeRequest(
    val mode: BackendMode,
    val imageUri: String,
    val instruction: String,
    val maxOutputTokens: Int,
    val temperature: Float
)

/**
 * Analyze result.
 */
data class AnalyzeResult(
    val text: String,
    val modelId: VlmModelId,
    val backend: String,
    val runtime: String,
    val diagnostics: List<String>
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("text", text)
        obj.put("modelId", modelId.wire)
        obj.put("backend", backend)
        obj.put("runtime", runtime)
        obj.put("diagnostics", JSArray(diagnostics))
        return obj
    }
}

/**
 * Inference state event.
 */
data class InferenceStateEvent(
    val modelId: VlmModelId,
    val state: VlmState,
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

/**
 * Embed texts result.
 */
data class EmbedTextsResult(
    val vectors: List<List<Float>>
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        val outer = JSArray()
        vectors.forEach { outer.put(JSArray(it)) }
        obj.put("vectors", outer)
        return obj
    }
}