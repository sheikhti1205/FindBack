package com.findback.app.vlm

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

@CapacitorPlugin(name = "LocalVlm")
class LocalVlmPlugin : Plugin() {

    private val modelStates = ConcurrentHashMap<VlmModelId, VlmModelInfo>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val executor = Executors.newSingleThreadExecutor()
    private val store: ModelStore by lazy { ModelStore.create(getContext()) }
    private val downloader: ModelDownloader by lazy { ModelDownloader(getContext(), store) }
    private val prefs: SharedPreferences by lazy { getContext().getSharedPreferences("findback_vlm", Context.MODE_PRIVATE) }
    private val activeDownloads = ConcurrentHashMap<VlmModelId, Job>()
    private var currentMode: BackendMode = BackendMode.AUTO

    // Inference mutex to serialize inference calls
    private val inferenceMutex = InferenceMutex()

    // Engine instances (lazy initialized per model)
    private val engine500: VlmEngine500? by lazy {
        val context = getContext()
        val manifest = MODEL_MANIFESTS.find { it.id == VlmModelId.SMOLVLM2_500M.wire }
        val modelFile = manifest?.files?.firstOrNull()?.let { spec ->
            store.finalFile(manifest, spec)
        }
        modelFile?.let { file ->
            if (file.exists()) {
                VlmEngine500(context, file.absolutePath, context.cacheDir)
            } else null
        }
    }

    init {
        // Load persisted mode
        val modeWire = prefs.getString("mode", null)
        modeWire?.let { BackendMode.fromWire(it)?.let { currentMode = it } }

        // Initialize model states from persisted records
        for (modelId in VlmModelId.values()) {
            val record = store.loadRecord(modelId)
            val state = record?.state ?: VlmState.NOT_INSTALLED
            modelStates[modelId] = VlmModelInfo(modelId, state, record?.installedBytes)
        }
    }

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        val context = getContext()
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
        val androidVersion = Build.VERSION.RELEASE
        val apiLevel = Build.VERSION.SDK_INT
        val hardware = Build.HARDWARE
        val deviceCategory = if (Build.FINGERPRINT.contains("generic") || Build.HARDWARE.contains("goldfish") || Build.PRODUCT.contains("sdk")) {
            DeviceCategory.EMULATOR
        } else {
            DeviceCategory.PHYSICAL
        }
        val gpuVendor: String? = null // Would need EGL to query
        val gpuRenderer: String? = null // Would need EGL to query
        val memoryClassMb = (context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager).memoryClass
        val freeAppStorageMb = getFreeAppStorageMb(context)
        val gpuRuntimePresent = checkGpuRuntimePresent()
        val runtimeVersion = "0.16.0" // LiteRT version

        val capabilities = VlmCapabilities(
            abi = abi,
            androidVersion = androidVersion,
            apiLevel = apiLevel,
            hardware = hardware,
            deviceCategory = deviceCategory,
            gpuVendor = gpuVendor,
            gpuRenderer = gpuRenderer,
            memoryClassMb = memoryClassMb,
            freeAppStorageMb = freeAppStorageMb,
            gpuRuntimePresent = gpuRuntimePresent,
            runtimeVersion = runtimeVersion
        )
        call.resolve(capabilities.toJSObject())
    }

    @PluginMethod
    fun getSettings(call: PluginCall) {
        val settings = VlmSettings(currentMode)
        call.resolve(settings.toJSObject())
    }

    @PluginMethod
    fun setMode(call: PluginCall) {
        val modeWire = call.getString("mode") ?: return
        BackendMode.fromWire(modeWire)?.let { mode ->
            currentMode = mode
            prefs.edit().putString("mode", mode.wire).apply()
            call.resolve()
        } ?: call.reject("Invalid mode: $modeWire")
    }

    @PluginMethod
    fun getModelStates(call: PluginCall) {
        // Reload from store to get latest state
        val models = VlmModelId.values().map { modelId ->
            val record = store.loadRecord(modelId)
            val state = record?.state ?: VlmState.NOT_INSTALLED
            val info = VlmModelInfo(modelId, state, record?.installedBytes, record?.lastError?.message)
            info.toJSObject()
        }.toTypedArray()
        val result = JSObject()
        result.put("models", models)
        call.resolve(result)
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.INSTALLED_UNVERIFIED || currentState == VlmState.READY_GPU) {
                call.reject("Model already downloaded or downloading")
                return
            }

            // Check storage upfront
            val totalExpectedBytes = manifest.files.sumOf { it.expectedBytes }
            val freeBytes = getFreeBytes()
            if (!ModelInstallPolicy.canInstall(freeBytes, totalExpectedBytes)) {
                val error = ModelError(VlmErrorCode.INSUFFICIENT_STORAGE, "Insufficient storage space")
                updateModelState(modelId, VlmState.INSUFFICIENT_STORAGE, error = error.message)
                call.reject("Insufficient storage")
                return
            }

            // Start download in background
            val job = scope.launch {
                try {
                    updateModelState(modelId, VlmState.DOWNLOADING)
                    val finalState = downloader.download(manifest) { downloaded, total ->
                        val progress = if (total > 0) downloaded.toFloat() / total else 0f
                        notifyListeners("downloadProgress", DownloadProgressEvent(modelId, progress, downloaded, total).toJSObject())
                    }
                    updateModelState(modelId, finalState)
                    if (finalState == VlmState.INSTALLED_UNVERIFIED) {
                        // Persist the installed state
                        persistModelState(modelId, manifest, finalState)
                    }
                    call.resolve()
                } catch (e: Exception) {
                    val error = ModelError(VlmErrorCode.DOWNLOAD_FAILED, e.message ?: "Download failed")
                    updateModelState(modelId, VlmState.DOWNLOAD_FAILED, error = error.message)
                    call.reject("Download failed: ${e.message}")
                } finally {
                    activeDownloads.remove(modelId)
                }
            }
            activeDownloads[modelId] = job
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val job = activeDownloads.remove(modelId)
            job?.cancel()
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING) {
                updateModelState(modelId, VlmState.NOT_INSTALLED)
            }
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            // Cancel any active download
            val job = activeDownloads.remove(modelId)
            job?.cancel()

            // Delete model files from store (preserves other models)
            store.deleteModel(modelId)

            // Release engine if it exists
            if (modelId == VlmModelId.SMOLVLM2_500M) {
                engine500?.release()
            }

            // Reset state
            updateModelState(modelId, VlmState.NOT_INSTALLED)
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun embedTexts(call: PluginCall) {
        val textsArray = call.getArray("texts") ?: return
        val texts = mutableListOf<String>()
        for (i in 0 until textsArray.length()) {
            texts.add(textsArray.getString(i) ?: "")
        }
        // Static/empty implementation for now
        val vectors = texts.map { List(384) { 0.0f } } // 384-dim placeholder
        val result = EmbedTextsResult(vectors)
        call.resolve(result.toJSObject())
    }

    @PluginMethod
    fun runGpuSelfTest(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        val imageUri = call.getString("imageUri") // Optional image for real self-test
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            when (modelId) {
                VlmModelId.SMOLVLM2_500M -> {
                    val engine = engine500 ?: run {
                        val result = GpuSelfTestResult(GpuSelfTestState.GPU_UNAVAILABLE, "Model not installed")
                        call.resolve(result.toJSObject())
                        return
                    }

                    scope.launch {
                        try {
                            updateModelState(modelId, VlmState.GPU_SELF_TESTING)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.GPU_SELF_TESTING).toJSObject())

                            val instruction = "Describe this image briefly."
                            val (success, diagnostics) = engine.runSelfTest(imageUri, instruction)

                            if (success) {
                                updateModelState(modelId, VlmState.READY_GPU)
                                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU).toJSObject())
                                val result = GpuSelfTestResult(GpuSelfTestState.GPU_AVAILABLE)
                                call.resolve(result.toJSObject())
                            } else {
                                // Without image, leave as INSTALLED_UNVERIFIED; with image failure, mark error
                                val finalState = if (imageUri != null) {
                                    VlmState.GPU_UNAVAILABLE
                                } else {
                                    VlmState.INSTALLED_UNVERIFIED
                                }
                                updateModelState(modelId, finalState, error = diagnostics.joinToString("; "))
                                notifyListeners("inferenceState", InferenceStateEvent(modelId, finalState, error = diagnostics.joinToString("; ")).toJSObject())
                                val result = GpuSelfTestResult(
                                    if (imageUri != null) GpuSelfTestState.GPU_UNAVAILABLE else GpuSelfTestState.GPU_UNSUPPORTED,
                                    diagnostics.joinToString("; ")
                                )
                                call.resolve(result.toJSObject())
                            }
                        } catch (e: Exception) {
                            updateModelState(modelId, VlmState.RUNTIME_ERROR, error = e.message)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = e.message).toJSObject())
                            val result = GpuSelfTestResult(GpuSelfTestState.ERROR, e.message)
                            call.resolve(result.toJSObject())
                        }
                    }
                }
                VlmModelId.SMOLVLM_256M -> {
                    // Check if model files exist
                    val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
                    val tfliteSpec = manifest.files.single { it.path.endsWith(".tflite") }
                    val tokenizerSpec = manifest.files.single { it.path == "tokenizer.model" }
                    val tfliteFile = store.finalFile(manifest, tfliteSpec)
                    val tokenizerFile = store.finalFile(manifest, tokenizerSpec)

                    if (!tfliteFile.exists() || !tokenizerFile.exists()) {
                        val result = GpuSelfTestResult(GpuSelfTestState.GPU_UNAVAILABLE, "Model files not found")
                        updateModelState(modelId, VlmState.GPU_UNAVAILABLE, error = "Model files not found")
                        notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.GPU_UNAVAILABLE, error = "Model files not found").toJSObject())
                        call.resolve(result.toJSObject())
                        return
                    }

                    scope.launch {
                        try {
                            updateModelState(modelId, VlmState.GPU_SELF_TESTING)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.GPU_SELF_TESTING).toJSObject())

                            val probe = Tflite256Probe(getContext(), store, ImagePreparer)
                            val (outcome, errorCode) = probe.runProbe()

                            updateModelState(modelId, outcome, error = errorCode?.wire)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, outcome, error = errorCode?.wire).toJSObject())

                            val gpuSelfTestState = when (outcome) {
                                VlmState.READY_GPU -> GpuSelfTestState.GPU_AVAILABLE
                                else -> GpuSelfTestState.GPU_UNAVAILABLE
                            }
                            val result = GpuSelfTestResult(gpuSelfTestState, errorCode?.wire)
                            call.resolve(result.toJSObject())
                        } catch (e: Exception) {
                            updateModelState(modelId, VlmState.RUNTIME_ERROR, error = e.message)
                            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = e.message).toJSObject())
                            val result = GpuSelfTestResult(GpuSelfTestState.ERROR, e.message)
                            call.resolve(result.toJSObject())
                        }
                    }
                }
            }
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun analyzeImage(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        val imageUri = call.getString("imageUri") ?: return
        val instruction = call.getString("instruction") ?: return
        val maxOutputTokens = call.getInt("maxOutputTokens") ?: 224
        val temperature = call.getFloat("temperature") ?: 0.1f

        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            if (modelId != VlmModelId.SMOLVLM2_500M) {
                call.reject("Only smolvlm2-500m supports image analysis")
                return
            }

            val engine = engine500 ?: run {
                call.reject("Model not installed or not ready")
                return
            }

            // Check if model is ready
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState != VlmState.READY_GPU) {
                call.reject("Model not ready for inference. State: ${currentState.wire}")
                return
            }

            // Try to acquire inference mutex
            if (!inferenceMutex.tryAcquire()) {
                call.reject("Inference already in progress")
                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = "Busy").toJSObject())
                return
            }

            scope.launch {
                try {
                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, progress = 0.1f).toJSObject())

                    // Prepare image
                    val prepared = ImagePreparer.prepare(getContext(), imageUri)

                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, progress = 0.3f).toJSObject())

                    // Run inference
                    val resultText = engine.analyze(prepared, instruction, maxOutputTokens, temperature)

                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, progress = 0.9f).toJSObject())

                    // Cleanup temp file
                    ImagePreparer.cleanup(prepared)

                    // Return result
                    val result = AnalyzeResult(
                        text = resultText,
                        modelId = modelId,
                        backend = EnginePolicy.backendName(),
                        runtime = "0.16.0",
                        diagnostics = emptyList()
                    )
                    call.resolve(result.toJSObject())
                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, progress = 1.0f).toJSObject())
                } catch (e: Exception) {
                    val errorMsg = e.message ?: "Inference failed"
                    call.reject("Inference failed: $errorMsg")
                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = errorMsg).toJSObject())
                } finally {
                    inferenceMutex.release()
                }
            }
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun cancelInference(call: PluginCall) {
        // Release mutex if held (best effort)
        if (inferenceMutex.isHeld()) {
            inferenceMutex.release()
        }
        call.resolve()
    }

    @PluginMethod
    fun release(call: PluginCall) {
        // Cancel all active downloads
        activeDownloads.values.forEach { it.cancel() }
        activeDownloads.clear()

        // Release engines
        engine500?.release()

        // Cancel coroutine scope
        scope.cancel()

        call.resolve()
    }

    @PluginMethod
    override fun addListener(call: PluginCall) {
        val eventName = call.getString("eventName") ?: return
        when (eventName) {
            "downloadProgress", "modelStateChange", "inferenceState" -> {
                call.resolve(JSObject().put("remove", JSObject()))
            }
            else -> call.reject("Unknown event: $eventName")
        }
    }

    private fun updateModelState(
        modelId: VlmModelId,
        state: VlmState,
        sizeBytes: Long? = null,
        error: String? = null
    ) {
        val info = VlmModelInfo(modelId, state, sizeBytes, error)
        modelStates[modelId] = info
        notifyListeners("modelStateChange", info.toJSObject())
    }

    private fun persistModelState(modelId: VlmModelId, manifest: ModelManifest, state: VlmState) {
        val files = manifest.files.map { spec ->
            val finalFile = store.finalFile(manifest, spec)
            val installedBytes = if (finalFile.exists()) finalFile.length() else spec.expectedBytes
            val installedSha256 = if (finalFile.exists()) Sha256.ofFile(finalFile) else spec.sha256
            InstalledFileRecord(spec.path, spec.expectedBytes, installedBytes, spec.sha256, installedSha256)
        }
        val totalInstalledBytes = files.sumOf { it.installedBytes }
        val aggregateSha256 = files.joinToString("") { it.installedSha256 }
        val record = ModelStateRecord(
            modelId = modelId,
            state = state,
            files = files,
            installedBytes = totalInstalledBytes,
            installTimestamp = System.currentTimeMillis(),
            runtimeVersion = manifest.runtime,
            appVersion = "1.0",
            fingerprint = Build.FINGERPRINT,
            abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown",
            gpuVendor = null,
            gpuRenderer = null,
            revision = manifest.revision,
            sha256 = aggregateSha256,
            lastGpuSelfTest = if (state == VlmState.READY_GPU) System.currentTimeMillis() else null,
            lastError = null
        )
        store.saveRecord(record)
    }

    private fun getFreeBytes(): Long {
        val file = getContext().filesDir
        val stat = android.os.StatFs(file.path)
        return stat.availableBlocksLong * stat.blockSizeLong
    }

    private fun getFreeAppStorageMb(context: Context): Long {
        val file = context.filesDir
        val stat = android.os.StatFs(file.path)
        return (stat.availableBlocksLong * stat.blockSizeLong) / (1024 * 1024)
    }

    private fun checkGpuRuntimePresent(): Boolean {
        return try {
            Class.forName("com.google.ai.edge.litert.gpu.GpuDelegate")
            true
        } catch (e: ClassNotFoundException) {
            false
        }
    }
}

/**
 * Model state info for plugin events.
 */
data class VlmModelInfo(
    val id: VlmModelId,
    val state: VlmState,
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