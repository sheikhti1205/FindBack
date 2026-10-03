package com.findback.app.needle

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * Needle TEXT challenger bridge: embeddings + single-record extraction
 * over the pinned needle3 engine (`findback_needle`, Cactus needle3
 * `.cact`, Apache-2.0).
 *
 * Engine calls serialize on one lock (process-global, non-thread-safe
 * runtime). Telemetry is disabled at the native boundary (`NEEDLE_TELEMETRY=0`
 * + `DO_NOT_TRACK=1` in JNI_OnLoad, before any engine call); the JS
 * telemetryGate stays the second, default-OFF gate.
 *
 * Weights resolve like the vision resident: an explicit `installedPath`
 * from the TS manager wins after a canonical-path check under app-private
 * files, else the conventional
 * `ai-models/models/needle3-cact-l20/<rev>/needle3.cact` tree is scanned.
 * Only `.cact` files load; anything else is `model_not_installed`, never
 * a guess.
 */
@CapacitorPlugin(name = "FindbackNeedle")
class FindbackNeedle : Plugin() {

    private val lock = Any()
    private var residentModelId: String? = null
    private var cachedDim: Int = 0

    @PluginMethod
    fun isNeedleAvailable(call: PluginCall) {
        val available = synchronized(lock) {
            residentModelId != null && NeedleBridge.ensureLoaded()
        }
        val ret = JSObject()
        ret.put("available", available)
        call.resolve(ret)
    }

    @PluginMethod
    fun loadNeedleModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId.isNullOrBlank()) {
            call.reject("unknown_model")
            return
        }
        val modelFile = resolveModelFile(modelId, call.getString("installedPath"))
        if (modelFile == null) {
            call.reject("model_not_installed")
            return
        }
        try {
            synchronized(lock) {
                if (!NeedleBridge.ensureLoaded()) {
                    call.reject("runtime_unavailable")
                    return
                }
                NeedleBridge.nativeLoad(modelFile.absolutePath)
                val kinds = NeedleBridge.nativeModels()
                if (kinds and NEEDLE_TEXT == 0) {
                    NeedleBridge.nativeUnload()
                    call.reject("runtime_load_failed", "needle text model not present")
                    return
                }
                cachedDim = NeedleBridge.nativeEmbedDim()
                if (cachedDim <= 0) {
                    NeedleBridge.nativeUnload()
                    call.reject("runtime_load_failed", "needle dimension probe failed")
                    return
                }
                residentModelId = modelId
            }
            val ret = JSObject()
            ret.put("ready", true)
            ret.put("dimension", cachedDim)
            call.resolve(ret)
        } catch (e: NativeNeedleException) {
            synchronized(lock) {
                residentModelId = null
                cachedDim = 0
            }
            call.reject(mapCode(e.code), e.message?.take(400))
        } catch (e: Exception) {
            synchronized(lock) {
                residentModelId = null
                cachedDim = 0
            }
            call.reject("runtime_load_failed", e.message?.take(400))
        }
    }

    @PluginMethod
    fun embeddingDimension(call: PluginCall) {
        val dim = synchronized(lock) { cachedDim }
        if (dim <= 0) {
            call.reject("runtime_unavailable")
            return
        }
        val ret = JSObject()
        ret.put("dimension", dim)
        call.resolve(ret)
    }

    @PluginMethod
    fun embedNeedleTexts(call: PluginCall) {
        val texts = call.getArray("texts")
        if (texts == null || texts.length() == 0) {
            call.reject("invalid_request")
            return
        }
        try {
            val rows = JSArray()
            synchronized(lock) {
                if (residentModelId == null || !NeedleBridge.ensureLoaded()) {
                    call.reject("runtime_unavailable")
                    return
                }
                val dim = cachedDim
                for (i in 0 until texts.length()) {
                    val text = texts.getString(i) ?: ""
                    if (text.isBlank() || text.length > MAX_TEXT_LENGTH) {
                        call.reject("invalid_request")
                        return
                    }
                    val vector = NeedleBridge.nativeEmbed(text, dim)
                    val row = JSArray()
                    for (value in vector) row.put(value.toDouble())
                    rows.put(row)
                }
            }
            val ret = JSObject()
            ret.put("vectors", rows)
            call.resolve(ret)
        } catch (e: NativeNeedleException) {
            call.reject(mapCode(e.code), e.message?.take(400))
        } catch (e: Exception) {
            call.reject("generation_failed", e.message?.take(400))
        }
    }

    @PluginMethod
    fun initNeedleTools(call: PluginCall) {
        try {
            synchronized(lock) {
                if (residentModelId == null || !NeedleBridge.ensureLoaded()) {
                    call.reject("runtime_unavailable")
                    return
                }
                NeedleBridge.nativeInitTools(
                    call.getString("systemPrompt"),
                    call.getString("toolsJson"),
                )
            }
            call.resolve()
        } catch (e: NativeNeedleException) {
            call.reject(mapCode(e.code), e.message?.take(400))
        } catch (e: Exception) {
            call.reject("runtime_load_failed", e.message?.take(400))
        }
    }

    @PluginMethod
    fun completeNeedleJson(call: PluginCall) {
        val input = call.getString("input")
        if (input.isNullOrBlank()) {
            call.reject("invalid_request")
            return
        }
        val maxTokens = call.getInt("maxNewTokens", 256) ?: 256
        try {
            val output = synchronized(lock) {
                if (residentModelId == null || !NeedleBridge.ensureLoaded()) {
                    call.reject("runtime_unavailable")
                    return
                }
                NeedleBridge.nativeComplete(input, maxTokens)
            }
            val ret = JSObject()
            ret.put("output", output)
            call.resolve(ret)
        } catch (e: NativeNeedleException) {
            call.reject(mapCode(e.code), e.message?.take(400))
        } catch (e: Exception) {
            call.reject("generation_failed", e.message?.take(400))
        }
    }

    @PluginMethod
    fun unloadNeedleModel(call: PluginCall) {
        synchronized(lock) {
            try {
                if (NeedleBridge.ensureLoaded()) NeedleBridge.nativeUnload()
            } catch (_: Exception) {
            }
            residentModelId = null
            cachedDim = 0
        }
        call.resolve()
    }

    private fun resolveModelFile(modelId: String, installedPath: String?): File? {
        if (!installedPath.isNullOrBlank()) {
            val candidate = File(installedPath)
            if (isUnderAppFiles(candidate) && candidate.isFile && candidate.extension == CACT_EXTENSION) {
                return candidate
            }
            return null
        }
        if (!MODEL_ID_PATTERN.matches(modelId)) return null
        val root = File(context.filesDir, AI_MODELS_DIR)
        val modelDir = File(root, "models/$modelId")
        if (!isUnderAppFiles(modelDir) || !modelDir.isDirectory) return null
        return modelDir.walkTopDown()
            .firstOrNull { it.isFile && it.extension == CACT_EXTENSION }
            ?.takeIf { isUnderAppFiles(it) }
    }

    private fun isUnderAppFiles(file: File): Boolean {
        return try {
            val base = context.filesDir.canonicalPath
            val target = file.canonicalPath
            target == base || target.startsWith("$base/")
        } catch (_: Exception) {
            false
        }
    }

    private fun mapCode(native: String): String {
        return when (native) {
            "model_not_installed" -> "model_not_installed"
            "runtime_unavailable" -> "runtime_unavailable"
            "load_failed" -> "runtime_load_failed"
            "init_failed" -> "runtime_load_failed"
            "embed_failed", "generation_failed" -> "generation_failed"
            else -> "runtime_load_failed"
        }
    }

    companion object {
        private const val CACT_EXTENSION = "cact"
        private const val AI_MODELS_DIR = "ai-models"
        private const val MAX_TEXT_LENGTH = 5000
        private const val NEEDLE_TEXT = 1
        private val MODEL_ID_PATTERN = Regex("[A-Za-z0-9._-]+")
    }
}
