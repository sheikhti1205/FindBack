package com.findback.app.vlm

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CancellationException
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

    // Initialized in load() after super.load(): getContext() is only valid
    // once the plugin is loaded, so no context-dependent work may happen in
    // init{} or lazy initializers.
    private var store: ModelStore? = null
    private var downloader: ModelDownloader? = null
    private var prefs: SharedPreferences? = null
    private var expiryHandler: Handler? = null
    @Volatile private var initialized = false

    private val activeDownloads = ConcurrentHashMap<VlmModelId, Job>()
    private var currentMode: BackendMode = BackendMode.AUTO
    private var eventCollector: Job? = null

    // Single-resident warm engine lease (~60s idle TTL): the engine stays
    // loaded while the active report AI flow continues; each inference
    // refreshes the lease. Never keep both VLM engines resident together.
    private val warmLease = WarmEngineLease(
        clock = object : WarmEngineLease.Clock {
            override fun nowMs(): Long = System.currentTimeMillis()
        }
    )

    // Inference mutex to serialize inference calls
    private val inferenceMutex = InferenceMutex()

    // Cancellation token + native-running guard for the active inference.
    // Cancel only flips the token so the stale result is ignored; the mutex
    // stays held until the native analyze() returns (see finally below).
    private val activeInference = ActiveInferenceController()

    // Engine instances (initialized on demand, re-initialized after model changes)
    private var engine500: VlmEngine500? = null

    private fun requireStore(): ModelStore = store ?: throw IllegalStateException("Plugin not initialized")
    private fun requireDownloader(): ModelDownloader = downloader ?: throw IllegalStateException("Plugin not initialized")
    private fun requirePrefs(): SharedPreferences = prefs ?: throw IllegalStateException("Plugin not initialized")

    /**
     * Rejects the call when load() has not completed yet.
     */
    private fun ensureInitialized(call: PluginCall): Boolean {
        if (!initialized || store == null || downloader == null || prefs == null) {
            call.reject("Plugin not initialized")
            return false
        }
        return true
    }

    private fun initializeEngine500(): VlmEngine500? {
        val context = getContext()
        val manifest = MODEL_MANIFESTS.find { it.id == VlmModelId.SMOLVLM2_500M.wire }
        val modelFile = manifest?.files?.firstOrNull()?.let { spec ->
            requireStore().finalFile(manifest, spec)
        }
        return modelFile?.let { file ->
            if (file.exists()) {
                VlmEngine500(context, file.absolutePath, context.cacheDir)
            } else null
        }
    }

    private fun releaseEngine500() {
        engine500?.release()
        engine500 = null
    }

    /**
     * Releases the resident engine when the warm-lease TTL expired.
     * Called on inference entry points and state reads so idle engines are
     * reclaimed without a timer, and Stage 1 -> Stage 2 stays warm.
     * Never releases underneath a running native inference.
     */
    private fun reclaimExpiredLease() {
        if (activeInference.isNativeRunning()) return
        val expired = warmLease.takeExpiredResident() ?: return
        releaseEngine500()
        notifyListeners("warmLeaseExpired", warmLeaseEvent(expired))
    }

    private fun warmLeaseEvent(modelId: VlmModelId): JSObject {
        val obj = JSObject()
        obj.put("modelId", modelId.wire)
        return obj
    }

    /**
     * Self-expiring lease: posts a Handler reclaim for the TTL deadline on
     * every acquire/refresh instead of polling with a timer.
     */
    private val leaseExpiryRunnable = Runnable {
        reclaimExpiredLease()
    }

    private fun scheduleLeaseExpiry() {
        val handler = expiryHandler ?: return
        handler.removeCallbacks(leaseExpiryRunnable)
        val delayMs = warmLease.timeUntilExpiryMs()
        if (delayMs > 0) {
            handler.postDelayed(leaseExpiryRunnable, delayMs)
        }
    }

    private fun cancelLeaseExpiry() {
        expiryHandler?.removeCallbacks(leaseExpiryRunnable)
    }

    override fun load() {
        super.load()
        // getContext() is valid from here on; nothing above may touch it.
        store = ModelStore.create(getContext())
        downloader = ModelDownloader(getContext(), requireStore())
        prefs = getContext().getSharedPreferences("findback_vlm", Context.MODE_PRIVATE)
        expiryHandler = Handler(Looper.getMainLooper())

        // Restore persisted mode.
        val modeWire = requirePrefs().getString("mode", null)
        modeWire?.let { BackendMode.fromWire(it)?.let { currentMode = it } }

        // Restore persisted model states. A persisted transient transfer
        // state with no live job means the process died mid-transfer:
        // reconcile to PAUSED (resume preserved via journal + verified
        // chunks) instead of showing a stuck DOWNLOADING.
        for (manifest in MODEL_MANIFESTS) {
            val modelId = VlmModelId.fromWire(manifest.id) ?: continue
            var record = requireStore().loadRecord(modelId)
            var state = record?.state ?: VlmState.NOT_INSTALLED
            val reconciled = TransferReconcile.reconcileState(
                state,
                hasLiveJob = activeDownloads.containsKey(modelId)
            )
            if (reconciled != state) {
                requireStore().saveTransferRecord(manifest, reconciled)
                record = requireStore().loadRecord(modelId)
                state = reconciled
            }
            modelStates[modelId] = VlmModelInfo(modelId, state, record?.installedBytes)
        }
        initialized = true

        eventCollector?.cancel()
        eventCollector = scope.launch {
            TransferEvents.events.collect { event ->
                updateModelState(event.modelId, event.state, error = event.error)
                if (event.state == VlmState.DOWNLOADING && event.totalBytes > 0) {
                    val progress = event.downloadedBytes.toFloat() / event.totalBytes
                    notifyListeners(
                        "downloadProgress",
                        DownloadProgressEvent(event.modelId, progress, event.downloadedBytes, event.totalBytes).toJSObject()
                    )
                }
                if (event.state == VlmState.INSTALLED_UNVERIFIED && event.modelId == VlmModelId.SMOLVLM2_500M) {
                    engine500 = initializeEngine500()
                }
            }
        }
    }

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        if (!ensureInitialized(call)) return
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
        val result = JSObject()
        result.put("capabilities", capabilities.toJSObject())
        call.resolve(result)
    }

    @PluginMethod
    fun getSettings(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val settings = VlmSettings(currentMode)
        call.resolve(settings.toJSObject())
    }

    @PluginMethod
    fun setMode(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modeWire = call.getString("mode") ?: return
        BackendMode.fromWire(modeWire)?.let { mode ->
            currentMode = mode
            requirePrefs().edit().putString("mode", mode.wire).apply()
            call.resolve()
        } ?: call.reject("Invalid mode: $modeWire")
    }

    @PluginMethod
    fun getModelStates(call: PluginCall) {
        if (!ensureInitialized(call)) return
        // Reload from store to get latest state
        val models = VlmModelId.values().map { modelId ->
            val record = requireStore().loadRecord(modelId)
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
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val manifest = MODEL_MANIFESTS.single { it.id == modelId.wire }
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.QUEUED ||
                currentState == VlmState.INSTALLED_UNVERIFIED || currentState == VlmState.READY_GPU
            ) {
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

            TransferControls.setUserPaused(getContext(), modelId, false)
            updateModelState(modelId, VlmState.QUEUED)

            // Platform scheduler (UIDT on API 34+, WorkManager below) running
            // the shared chunk engine. Resolve immediately so the confirmation
            // dialog closes and progress/cancel UI stays visible.
            val scheduled = try {
                ModelDownloadScheduler.schedule(getContext(), modelId, networkPolicy(call))
            } catch (e: Exception) {
                false
            }
            if (scheduled) {
                call.resolve()
                return
            }

            // Foreground fallback must still honor Wi-Fi-only: never pull a
            // multi-hundred-MB model over a metered link without opt-in.
            if (networkPolicy(call) == ModelDownloadScheduler.NetworkPolicy.WIFI_ONLY && !isUnmetered()) {
                updateModelState(modelId, VlmState.WAITING_FOR_WIFI)
                call.reject("Waiting for Wi-Fi (enable Wi-Fi or allow cellular)")
                return
            }

            // Fallback: direct foreground download with the same chunk engine.
            val job = scope.launch {
                try {
                    updateModelState(modelId, VlmState.DOWNLOADING)
                    val finalState = requireDownloader().download(
                        manifest = manifest,
                        onProgress = { downloaded, total ->
                            val progress = if (total > 0) downloaded.toFloat() / total else 0f
                            notifyListeners("downloadProgress", DownloadProgressEvent(modelId, progress, downloaded, total).toJSObject())
                        },
                        onState = { transferState ->
                            if (transferState != VlmState.DOWNLOADING) {
                                updateModelState(modelId, transferState)
                            }
                        }
                    )
                    updateModelState(modelId, finalState)
                    if (finalState == VlmState.INSTALLED_UNVERIFIED) {
                        // Persist the installed state
                        persistModelState(modelId, manifest, finalState)
                        // Re-initialize engine if this is the 500M model
                        if (modelId == VlmModelId.SMOLVLM2_500M) {
                            engine500 = initializeEngine500()
                        }
                    }
                    call.resolve()
                } catch (e: CancellationException) {
                    // Job cancelled (pause/cancel/teardown): not a failure.
                    // The scheduler path or a later resume owns the state.
                    throw e
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
    fun pauseDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            // Graceful stop preserving verified chunks; the pause sticks
            // across scheduler restarts until resume.
            TransferControls.setUserPaused(getContext(), modelId, true)
            activeDownloads[modelId]?.let { requireDownloader().requestPause() }
            ModelDownloadScheduler.cancel(getContext(), modelId)
            updateModelState(modelId, VlmState.PAUSING)
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun resumeDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.QUEUED) {
                call.reject("Download already in progress")
                return
            }
            TransferControls.setUserPaused(getContext(), modelId, false)
            updateModelState(modelId, VlmState.QUEUED)
            // Resume continues missing chunks only; verified ranges are kept.
            val scheduled = try {
                ModelDownloadScheduler.schedule(getContext(), modelId, networkPolicy(call))
            } catch (e: Exception) {
                false
            }
            if (!scheduled) {
                call.reject("Unable to schedule download")
                return
            }
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    /**
     * Repair path for REPAIR_NEEDED/CORRUPT/MANIFEST_MISMATCH: rescans chunks,
     * preserves good bytes, and re-fetches only bad ranges. Never loops
     * automatically on manifest mismatch.
     */
    @PluginMethod
    fun repairModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            TransferControls.setUserPaused(getContext(), modelId, false)
            updateModelState(modelId, VlmState.REPAIR_NEEDED)
            val scheduled = try {
                ModelDownloadScheduler.schedule(getContext(), modelId, networkPolicy(call))
            } catch (e: Exception) {
                false
            }
            if (!scheduled) {
                call.reject("Unable to schedule repair")
                return
            }
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        // Keep downloaded data for later (default) vs remove partial download.
        val removePartial = call.getBoolean("removePartial") ?: false
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val job = activeDownloads.remove(modelId)
            requireDownloader().requestCancel(removePartial)
            job?.cancel()
            ModelDownloadScheduler.cancel(getContext(), modelId)
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.QUEUED ||
                currentState == VlmState.PAUSING
            ) {
                if (removePartial) {
                    val manifest = MODEL_MANIFESTS.singleOrNull { it.id == modelId.wire }
                    if (manifest != null) {
                        for (spec in manifest.files) {
                            requireStore().partFile(manifest, spec).delete()
                            requireStore().journalFile(manifest, spec).delete()
                            requireStore().chunkTmpFile(manifest, spec).delete()
                        }
                    }
                    updateModelState(modelId, VlmState.NOT_INSTALLED)
                } else {
                    // Keep verified chunks for later resume.
                    updateModelState(modelId, VlmState.PAUSED)
                }
            }
            requireDownloader().resetControl()
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            // Never close the engine or delete files underneath a running
            // inference: reject BUSY so the UI can retry after completion.
            if (activeInference.isActive()) {
                call.reject("Inference in progress", "BUSY")
                return
            }
            // Confirmation is handled in UI; deletion here is exact and scoped:
            // unload engine, cancel transfer, remove only this model's
            // directory. The other model is unaffected.
            val job = activeDownloads.remove(modelId)
            requireDownloader().requestCancel(removePartial = true)
            job?.cancel()
            requireDownloader().resetControl()
            ModelDownloadScheduler.cancel(getContext(), modelId)
            TransferControls.setUserPaused(getContext(), modelId, false)

            // Delete model files from store (preserves other models)
            requireStore().deleteModel(modelId)

            // Release engine if it exists
            if (modelId == VlmModelId.SMOLVLM2_500M) {
                cancelLeaseExpiry()
                warmLease.releaseNow()
                releaseEngine500()
            }

            // Reset state
            updateModelState(modelId, VlmState.NOT_INSTALLED)
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun embedTexts(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val textsArray = call.getArray("texts") ?: return
        val texts = mutableListOf<String>()
        for (i in 0 until textsArray.length()) {
            texts.add(textsArray.getString(i) ?: "")
        }

        // Try to acquire inference mutex
        if (!inferenceMutex.tryAcquire()) {
            call.reject("Inference already in progress", "MODEL_UNAVAILABLE")
            return
        }

        scope.launch {
            try {
                val embedder = UniversalSentenceEmbedder.getInstance(getContext())
                if (embedder == null) {
                    call.reject("Embedding model not available", "MODEL_UNAVAILABLE")
                    return@launch
                }

                val vectors = embedder.embedTexts(texts)
                val result = EmbedTextsResult(vectors)
                call.resolve(result.toJSObject())
            } catch (e: Exception) {
                val errorMsg = e.message ?: "Embedding failed"
                call.reject("Embedding failed: $errorMsg", "MODEL_UNAVAILABLE")
            } finally {
                inferenceMutex.release()
            }
        }
    }

    @PluginMethod
    fun runGpuSelfTest(call: PluginCall) {
        if (!ensureInitialized(call)) return
        val modelIdWire = call.getString("modelId") ?: return
        val imageUri = call.getString("imageUri") // Optional image for real self-test
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            when (modelId) {
                VlmModelId.SMOLVLM2_500M -> {
                    // Ensure engine is initialized (handles case where model was downloaded but engine not yet created)
                    var engine = engine500
                    if (engine == null) {
                        engine = initializeEngine500()
                        engine500 = engine
                    }
                    val engineInstance = engine ?: run {
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
                    val tfliteFile = requireStore().finalFile(manifest, tfliteSpec)
                    val tokenizerFile = requireStore().finalFile(manifest, tokenizerSpec)

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

                            val probe = Tflite256Probe(getContext(), requireStore(), ImagePreparer)
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
        if (!ensureInitialized(call)) return
        val modeWire = call.getString("mode") ?: run {
            call.reject("Missing mode")
            return
        }
        val mode = BackendMode.fromWire(modeWire) ?: run {
            call.reject("Invalid mode: $modeWire")
            return
        }
        val imageUri = call.getString("imageUri") ?: run {
            call.reject("Missing imageUri")
            return
        }
        val instruction = call.getString("instruction") ?: run {
            call.reject("Missing instruction")
            return
        }
        val maxOutputTokens = call.getInt("maxOutputTokens") ?: 224
        val temperature = call.getFloat("temperature") ?: 0.1f

        val selectedModel = VlmRouter.selectForAnalysis(mode, modelStates.mapValues { it.value.state })
        val modelId = when (selectedModel) {
            is AnalysisSelection.Ready -> selectedModel.modelId
            is AnalysisSelection.Unsupported -> {
                call.reject(selectedModel.reason)
                return
            }
        }

        // Ensure engine is initialized (handles case where model was downloaded but engine not yet created)
        var engine = engine500
        if (engine == null) {
            engine = initializeEngine500()
            engine500 = engine
        }
        val engineInstance = engine ?: run {
            call.reject("Model not installed or not ready")
            return
        }

        // Check if model is ready
        val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
        if (currentState != VlmState.READY_GPU) {
            call.reject("Model not ready for inference. State: ${currentState.wire}")
            return
        }

        // Single-resident warm lease: Stage 1 -> Stage 2 stays warm, each
        // inference refreshes the ~60s TTL, model switch releases the old
        // engine. No silent CPU fallback anywhere on this path.
        reclaimExpiredLease()
        warmLease.acquire(modelId) { warmLease.releaseNow(); releaseEngine500() }
        scheduleLeaseExpiry()

        // Try to acquire inference mutex
        if (!inferenceMutex.tryAcquire()) {
            call.reject("Inference already in progress")
            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = "Busy").toJSObject())
            return
        }
        // Cancellation token for this inference. cancelInference() flips the
        // token so the stale result is ignored, but the mutex stays held
        // until the native analyze() returns (released in finally below).
        val token = activeInference.begin()
        if (token == null) {
            inferenceMutex.release()
            call.reject("Inference already in progress")
            notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = "Busy").toJSObject())
            return
        }

        scope.launch {
            var prepared: ImagePreparer.PreparedImage? = null
            try {
                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, progress = 0.1f).toJSObject())

                // Prepare image (temp file tracked for guaranteed cleanup).
                prepared = ImagePreparer.prepare(getContext(), imageUri)

                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, progress = 0.3f).toJSObject())

                // Run inference with the native-running flag held so
                // delete/release paths defer instead of closing underneath.
                activeInference.markNativeRunning(token, true)
                val resultText = try {
                    engineInstance.analyze(prepared, instruction, maxOutputTokens, temperature)
                } finally {
                    activeInference.markNativeRunning(token, false)
                }

                // A cancelled inference never resolves JS: drop the stale result.
                if (activeInference.isCancelled(token)) {
                    return@launch
                }

                // Inference completed: refresh the warm lease.
                warmLease.refresh()
                scheduleLeaseExpiry()

                notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.READY_GPU, progress = 0.9f).toJSObject())

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
            } catch (e: CancellationException) {
                // Cancelled coroutine: never resolve the stale call.
                throw e
            } catch (e: Exception) {
                if (!activeInference.isCancelled(token)) {
                    val errorMsg = e.message ?: "Inference failed"
                    call.reject("Inference failed: $errorMsg")
                    notifyListeners("inferenceState", InferenceStateEvent(modelId, VlmState.RUNTIME_ERROR, error = errorMsg).toJSObject())
                }
            } finally {
                prepared?.let { ImagePreparer.cleanup(it) }
                val deferredRelease = activeInference.finishNative(token)
                inferenceMutex.release()
                if (deferredRelease) {
                    releaseEngine500()
                }
            }
        }
    }

    @PluginMethod
    fun cancelInference(call: PluginCall) {
        if (!ensureInitialized(call)) return
        // Best effort: flag the active inference cancelled so its eventual
        // result is ignored. The mutex stays held until the native analyze()
        // returns — never unlock early, never resolve the stale call.
        activeInference.cancel()
        call.resolve()
    }

    @PluginMethod
    fun release(call: PluginCall) {
        if (!ensureInitialized(call)) return
        // Cancel all active downloads
        activeDownloads.values.forEach { it.cancel() }
        activeDownloads.clear()

        // Release engines + warm lease immediately (memory trim / teardown),
        // unless native inference is running: then flag cancel and defer the
        // engine close until the native call returns (see analyze finally).
        cancelLeaseExpiry()
        warmLease.releaseNow()
        if (activeInference.isNativeRunning()) {
            activeInference.cancel()
            activeInference.deferEngineRelease()
        } else {
            releaseEngine500()
        }

        // Cancel coroutine scope
        eventCollector?.cancel()
        scope.cancel()

        call.resolve()
    }

    /**
     * Releases the warm engine lease immediately (leaving the AI flow,
     * memory trim, sustained background). The next inference re-acquires.
     */
    @PluginMethod
    fun releaseWarmLease(call: PluginCall) {
        if (!ensureInitialized(call)) return
        if (activeInference.isActive()) {
            call.reject("Inference in progress", "BUSY")
            return
        }
        cancelLeaseExpiry()
        warmLease.releaseNow()
        releaseEngine500()
        call.resolve()
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
            val finalFile = requireStore().finalFile(manifest, spec)
            if (finalFile.exists() && finalFile.length() == spec.expectedBytes &&
                Sha256.matchesFile(finalFile, spec.sha256)
            ) {
                // Whole-file verified: report true bytes + hash.
                InstalledFileRecord(spec.path, spec.expectedBytes, finalFile.length(), spec.sha256, spec.sha256)
            } else {
                // Not verified: installed bytes are verified journal bytes
                // (never the preallocated .part length) and no installed SHA.
                val journal = TransferJournalStore.load(requireStore().journalFile(manifest, spec))
                InstalledFileRecord(
                    spec.path,
                    spec.expectedBytes,
                    TransferJournalStore.verifiedBytes(spec.expectedBytes, journal),
                    spec.sha256,
                    ""
                )
            }
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
        requireStore().saveRecord(record)
    }

    /**
     * Network policy for a transfer call. Defaults to Wi-Fi only; the JS
     * layer must explicitly pass `allowCellular: true` for the user's
     * Wi-Fi-or-cellular setting. Never silently downloads over metered links.
     */
    private fun networkPolicy(call: PluginCall): ModelDownloadScheduler.NetworkPolicy =
        if (call.getBoolean("allowCellular") == true) {
            ModelDownloadScheduler.NetworkPolicy.WIFI_OR_CELLULAR
        } else {
            ModelDownloadScheduler.NetworkPolicy.WIFI_ONLY
        }

    private fun isUnmetered(): Boolean {
        return try {
            val cm = getContext().getSystemService(Context.CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val net = cm.activeNetwork ?: return false
            val caps = cm.getNetworkCapabilities(net) ?: return false
            caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        } catch (e: Exception) {
            false
        }
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
