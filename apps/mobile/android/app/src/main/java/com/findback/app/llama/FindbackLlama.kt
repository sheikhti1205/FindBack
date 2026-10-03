package com.findback.app.llama

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

/**
 * llama.cpp lab challenger bridge (pinned v0.5.0 source, CPU-only).
 *
 * LAB SCOPE, enforced at every entry point: this plugin serves GGUF
 * evaluation behind the TS license gate + benchmark/eval channel check.
 * It never registers with the orchestrator, router, Needle, probe, UI, or
 * packer — the challenger harness calls it explicitly for benchmarks.
 * LFM-licensed arms stay blocked from production distribution by
 * `licenseGate`, independent of this runtime existing.
 *
 * Generations serialize on one lock and stream as `llamaChunk` listener
 * events keyed by `generationId`; `cancelGeneration` is cooperative.
 * GGUF weights resolve like every other resident: explicit `ggufPath`
 * under app-private files wins, else the conventional
 * `ai-models/models/<modelId>/<revision>/` tree is scanned for GGUF files.
 */
@CapacitorPlugin(name = "FindbackLlama")
class FindbackLlama : Plugin() {

    private val lock = Any()
    private var residentModelId: String? = null
    private val activeFlags = mutableMapOf<String, Boolean>()

    @PluginMethod
    fun isLlamaAvailable(call: PluginCall) {
        val available = synchronized(lock) {
            residentModelId != null && LlamaBridge.ensureLoaded()
        }
        val ret = JSObject()
        ret.put("available", available)
        call.resolve(ret)
    }

    @PluginMethod
    fun loadLlamaModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId.isNullOrBlank()) {
            call.reject("unknown_model")
            return
        }
        val modelFile = resolveModelFile(modelId, call.getString("ggufPath"))
        if (modelFile == null) {
            call.reject("model_not_installed")
            return
        }
        val nCtx = call.getInt("nCtx", LAB_N_CTX) ?: LAB_N_CTX
        val nThreads = call.getInt("nThreads", LAB_N_THREADS) ?: LAB_N_THREADS
        call.setKeepAlive(true)
        Thread(
            {
                try {
                    synchronized(lock) {
                        if (!LlamaBridge.ensureLoaded()) {
                            call.reject("runtime_unavailable")
                            return@Thread
                        }
                        LlamaBridge.nativeInit()
                        LlamaBridge.nativeLoad(modelFile.absolutePath, nCtx, nThreads)
                        residentModelId = modelId
                    }
                    val ret = JSObject()
                    ret.put("ready", true)
                    try {
                        val info = synchronized(lock) { LlamaBridge.nativeSystemInfo() }
                        ret.put("systemInfo", info.take(400))
                    } catch (_: Exception) {
                    }
                    call.resolve(ret)
                } catch (e: NativeLlamaException) {
                    synchronized(lock) { residentModelId = null }
                    call.reject(mapCode(e.code), e.message?.take(400))
                } catch (e: Exception) {
                    synchronized(lock) { residentModelId = null }
                    call.reject("runtime_load_failed", e.message?.take(400))
                }
            },
            "findback-llama-load",
        ).start()
    }

    @PluginMethod
    fun inferLlama(call: PluginCall) {
        val generationId = call.getString("generationId")
        val prompt = call.getString("prompt")
        if (generationId.isNullOrBlank() || prompt.isNullOrBlank()) {
            call.reject("generation_failed")
            return
        }
        val maxTokens = call.getInt("maxTokens", LAB_MAX_TOKENS) ?: LAB_MAX_TOKENS
        synchronized(lock) {
            if (residentModelId == null || !LlamaBridge.ensureLoaded()) {
                call.reject("runtime_unavailable")
                return
            }
            activeFlags[generationId] = true
        }
        call.setKeepAlive(true)
        Thread(
            {
                try {
                    val consumed = synchronized(lock) { LlamaBridge.nativeBegin(prompt) }
                    if (consumed < 0) {
                        call.reject("generation_failed")
                        return@Thread
                    }
                    var emitted = 0
                    while (emitted < maxTokens) {
                        val alive = synchronized(lock) { activeFlags[generationId] == true }
                        if (!alive) {
                            notifyChunk(generationId, cancelled = true)
                            call.resolve()
                            return@Thread
                        }
                        val piece = synchronized(lock) {
                            try {
                                LlamaBridge.nativeNext()
                            } catch (e: NativeLlamaException) {
                                throw e
                            }
                        } ?: break
                        emitted += 1
                        notifyChunk(generationId, delta = piece)
                    }
                    notifyChunk(generationId, done = true)
                    call.resolve()
                } catch (e: NativeLlamaException) {
                    notifyChunk(generationId, error = e.message?.take(400))
                    call.reject(mapCode(e.code), e.message?.take(400))
                } catch (e: Exception) {
                    notifyChunk(generationId, error = e.message?.take(400))
                    call.reject("generation_failed", e.message?.take(400))
                } finally {
                    synchronized(lock) { activeFlags.remove(generationId) }
                }
            },
            "findback-llama-infer",
        ).start()
    }

    @PluginMethod
    fun cancelGeneration(call: PluginCall) {
        val generationId = call.getString("generationId")
        synchronized(lock) { activeFlags.remove(generationId) }
        try {
            if (LlamaBridge.ensureLoaded()) LlamaBridge.nativeCancel()
        } catch (_: Exception) {
        }
        call.resolve()
    }

    @PluginMethod
    fun unloadLlamaModel(call: PluginCall) {
        synchronized(lock) {
            activeFlags.clear()
            try {
                if (LlamaBridge.ensureLoaded()) LlamaBridge.nativeUnload()
            } catch (_: Exception) {
            }
            residentModelId = null
        }
        call.resolve()
    }

    private fun resolveModelFile(modelId: String, ggufPath: String?): File? {
        if (!ggufPath.isNullOrBlank()) {
            val candidate = File(ggufPath)
            if (isUnderAppFiles(candidate) && candidate.isFile && candidate.extension == GGUF_EXTENSION) {
                return candidate
            }
            return null
        }
        if (!MODEL_ID_PATTERN.matches(modelId)) return null
        val root = File(context.filesDir, AI_MODELS_DIR)
        val modelDir = File(root, "models/$modelId")
        if (!isUnderAppFiles(modelDir) || !modelDir.isDirectory) return null
        return modelDir.walkTopDown()
            .firstOrNull { it.isFile && it.extension == GGUF_EXTENSION }
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

    private fun notifyChunk(generationId: String, delta: String? = null, done: Boolean = false, cancelled: Boolean = false, error: String? = null) {
        val event = JSObject()
        event.put("generationId", generationId)
        if (delta != null) event.put("textDelta", delta)
        if (done) event.put("done", true)
        if (cancelled) event.put("cancelled", true)
        if (error != null) event.put("error", error)
        notifyListeners("llamaChunk", event)
    }

    private fun mapCode(native: String): String {
        return when (native) {
            "model_not_installed" -> "model_not_installed"
            "lab_not_loaded" -> "runtime_unavailable"
            "load_failed" -> "runtime_load_failed"
            else -> "generation_failed"
        }
    }

    companion object {
        private const val GGUF_EXTENSION = "gguf"
        private const val AI_MODELS_DIR = "ai-models"
        private const val LAB_N_CTX = 2048
        private const val LAB_N_THREADS = 4
        private const val LAB_MAX_TOKENS = 256
        private val MODEL_ID_PATTERN = Regex("[A-Za-z0-9._-]+")
    }
}
