package com.findback.app.vlm

import android.content.Context
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "LocalVlm")
class LocalVlmPlugin : Plugin() {

    private val mutex = InferenceMutex()
    private val modelStates = ConcurrentHashMap<VlmModelId, VlmModelInfo>()
    private var currentMode: BackendMode = BackendMode.AUTO

    init {
        // Initialize all models as NOT_INSTALLED
        for (modelId in VlmModelId.values()) {
            modelStates[modelId] = VlmModelInfo(modelId, VlmState.NOT_INSTALLED)
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
            call.resolve()
        } ?: call.reject("Invalid mode: $modeWire")
    }

    @PluginMethod
    fun getModelStates(call: PluginCall) {
        val models = modelStates.values.map { it.toJSObject() }.toTypedArray()
        val result = JSObject()
        result.put("models", models)
        call.resolve(result)
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING || currentState == VlmState.INSTALLED_UNVERIFIED || currentState == VlmState.READY_GPU) {
                call.reject("Model already downloaded or downloading")
                return
            }
            modelStates[modelId] = VlmModelInfo(modelId, VlmState.DOWNLOADING)
            notifyListeners("modelStateChange", modelStates[modelId]!!.toJSObject())

            // Simulate download progress
            // In real implementation, this would download the model file
            // For now, just mark as INSTALLED_UNVERIFIED after a short delay
            bridge?.execute {
                try {
                    Thread.sleep(100)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
                modelStates[modelId] = VlmModelInfo(modelId, VlmState.INSTALLED_UNVERIFIED, sizeBytes = 100_000_000L)
                notifyListeners("modelStateChange", modelStates[modelId]!!.toJSObject())
                notifyListeners("downloadProgress", DownloadProgressEvent(modelId, 1.0f, 100_000_000L, 100_000_000L).toJSObject())
                call.resolve()
            }
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            val currentState = modelStates[modelId]?.state ?: VlmState.NOT_INSTALLED
            if (currentState == VlmState.DOWNLOADING) {
                modelStates[modelId] = VlmModelInfo(modelId, VlmState.NOT_INSTALLED)
                notifyListeners("modelStateChange", modelStates[modelId]!!.toJSObject())
            }
            call.resolve()
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val modelIdWire = call.getString("modelId") ?: return
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            modelStates[modelId] = VlmModelInfo(modelId, VlmState.NOT_INSTALLED)
            notifyListeners("modelStateChange", modelStates[modelId]!!.toJSObject())
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
        VlmModelId.fromWire(modelIdWire)?.let { modelId ->
            // Static/empty implementation for now
            val result = GpuSelfTestResult(GpuSelfTestState.GPU_UNAVAILABLE)
            call.resolve(result.toJSObject())
        } ?: call.reject("Invalid modelId: $modelIdWire")
    }

    @PluginMethod
    fun analyzeImage(call: PluginCall) {
        // Reject with "Not implemented yet" as specified
        call.reject("Not implemented yet")
    }

    @PluginMethod
    fun cancelInference(call: PluginCall) {
        // Static/empty implementation for now
        call.resolve()
    }

    @PluginMethod
    fun release(call: PluginCall) {
        // Static/empty implementation for now
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

    private fun getFreeAppStorageMb(context: Context): Long {
        val file = context.filesDir
        val stat = android.os.StatFs(file.path)
        return (stat.availableBlocksLong * stat.blockSizeLong) / (1024 * 1024)
    }

    private fun checkGpuRuntimePresent(): Boolean {
        // Check if GPU delegate is available
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