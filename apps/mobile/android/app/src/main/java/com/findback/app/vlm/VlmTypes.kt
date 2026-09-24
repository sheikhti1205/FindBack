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
 * [path] is the local on-device storage name. [remotePath] is retained as
 * provenance-only metadata for previously pinned upstream files (e.g. the
 * 256M TFLite typo `smalvlm`); production downloads never build URLs from
 * it. Pinned release-asset downloads use [ModelManifest.distribution].
 */
data class ModelFileSpec(
    val path: String,
    val expectedBytes: Long,
    val sha256: String,
    val remotePath: String = path
)

/**
 * Shipped publication state of a release asset. UNPUBLISHED means the
 * package is prepared but not published in this build: no network download
 * may be offered and every URL-consumption path fails closed. Flipping an
 * entry to PUBLISHED is an app-release change.
 */
enum class DistributionState {
    UNPUBLISHED,
    PUBLISHED
}

/**
 * Pinned GitHub Release asset for one `.fbmodel` package. The runtime
 * builds the download URL from repo/tag/asset only; it never polls the
 * API and never uses latest/main. Upstream repo/revision/file stay as
 * provenance only. [parts] is null for single-asset v1 entries.
 */
data class ModelDistribution(
    val repo: String,
    val tag: String,
    val asset: String,
    val bytes: Long,
    val sha256: String,
    val state: DistributionState = DistributionState.UNPUBLISHED,
    val parts: List<DistributionPart>? = null
) {
    /** True only when the release asset is published and downloadable. */
    fun isPublished(): Boolean = state == DistributionState.PUBLISHED
}

/**
 * Honest failure note for unpublished distributions. The catalogue stays
 * authoritative: no HEAD requests, no API lookups, no existence probing.
 */
const val UNPUBLISHED_DISTRIBUTION_MESSAGE =
    "Package prepared but not published in this build. Network download is disabled."

/**
 * One chunk part when a single asset would exceed the per-asset limit.
 */
data class DistributionPart(
    val asset: String,
    val bytes: Long,
    val sha256: String
)

/**
 * Returns the pinned release-asset download URL, or null when the
 * manifest carries no distribution pin. No API polling, no latest/main,
 * no Hugging Face resolve URLs in the production path.
 */
fun distributionUrlFor(distribution: ModelDistribution): String {
    return "https://github.com/${distribution.repo}/releases/download/${distribution.tag}/${distribution.asset}"
}

/**
 * A model manifest with pinned revision, source repo, and file list.
 *
 * [sourceRepo] and [revision] are provenance-only (upstream identity for
 * storage paths and diagnostics); production downloads use [distribution].
 * A null [distribution] means the model has no release-asset download path
 * (legacy storage compatibility only).
 */
data class ModelManifest(
    val id: String,
    val sourceRepo: String,
    val revision: String,
    val files: List<ModelFileSpec>,
    val runtime: String,
    val distribution: ModelDistribution? = null,
    val rawSource: PinnedRawSource? = null
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
    val availableRamMb: Long? = null,
    /**
     * Whether the litert-gpu delegate class ships in the APK. Class
     * presence only — never LiteRT-LM runtime availability (audit #26).
     */
    val gpuDelegateClassPresent: Boolean,
    val runtimeVersion: String?,
    val appVersion: String?,
    val buildGitSha: String?,
    /** APK versionCode from the package manager; 0 when unreadable. */
    val versionCode: Int = 0
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
        if (availableRamMb != null) obj.put("availableRamMb", availableRamMb)
        obj.put("gpuDelegateClassPresent", gpuDelegateClassPresent)
        obj.put("runtimeVersion", runtimeVersion)
        obj.put("appVersion", appVersion)
        obj.put("buildGitSha", buildGitSha)
        obj.put("versionCode", versionCode)
        return obj
    }
}

/**
 * Settings.
 */
data class VlmSettings(
    val mode: BackendMode,
    val allowCpuFallback: Boolean = true
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("mode", mode.wire)
        obj.put("allowCpuFallback", allowCpuFallback)
        return obj
    }
}

/**
 * Engine execution backend for the 500M model. GPU is preferred; CPU is the
 * explicit compatibility path used only when GPU initialization fails and the
 * user allows it. Verification (self-test) always uses GPU.
 */
enum class VlmEngineBackend(val wire: String) {
    GPU("gpu"),
    CPU("cpu")
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
 * Inference phase. Phases are real stage transitions only: fabricated
 * percentages (0.1 / 0.3 / 0.9 / 1.0) must never be emitted (audit #27).
 * Contract with the UI: phase present means inference is active, phase
 * absent means idle.
 */
enum class InferencePhase(val wire: String) {
    PREPARING_IMAGE("PREPARING_IMAGE"),
    LOADING_MODEL("LOADING_MODEL"),
    RUNNING("RUNNING"),
    POSTPROCESSING("POSTPROCESSING");

    companion object {
        fun fromWire(wire: String): InferencePhase? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * Inference state event.
 */
data class InferenceStateEvent(
    val modelId: VlmModelId,
    val state: VlmState,
    val progress: Float? = null,
    val error: String? = null,
    val phase: InferencePhase? = null
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("modelId", modelId.wire)
        obj.put("state", state.wire)
        progress?.let { obj.put("progress", it) }
        error?.let { obj.put("error", it) }
        phase?.let { obj.put("phase", it.wire) }
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
 * GPU self-test failure classification (audit #25). A failed self-test is
 * never flattened into a bare GPU_UNAVAILABLE: the stage that failed travels
 * with the result so the UI can explain it.
 */
enum class SelfTestFailure(val wire: String) {
    INPUT_ERROR("INPUT_ERROR"),
    MODEL_RUNTIME_ERROR("MODEL_RUNTIME_ERROR"),
    GENERATION_ERROR("GENERATION_ERROR");

    companion object {
        fun fromWire(wire: String): SelfTestFailure? = values().firstOrNull { it.wire == wire }
    }
}

/**
 * Structured self-test outcome from [VlmEngine500.runSelfTest].
 */
data class SelfTestOutcome(
    val success: Boolean,
    val failure: SelfTestFailure? = null,
    val diagnostics: List<String> = emptyList()
)

/**
 * GPU self-test result.
 */
data class GpuSelfTestResult(
    val state: GpuSelfTestState,
    val error: String? = null,
    val failure: SelfTestFailure? = null
) {
    fun toJSObject(): JSObject {
        val obj = JSObject()
        obj.put("state", state.wire)
        error?.let { obj.put("error", it) }
        failure?.let { obj.put("failure", it.wire) }
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
