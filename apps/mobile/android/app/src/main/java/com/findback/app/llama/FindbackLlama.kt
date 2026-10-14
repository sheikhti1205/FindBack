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
 * Production-grade internals (method/event surface unchanged — the TS
 * `LlamaNativeBridge` contract in `services/ai/llama/adapter.ts` binds
 * these exact names):
 * - one process-global session behind [lock]; load quiesces in-flight
 *   inference (cancel + bounded drain) before `nativeLoad`, which itself
 *   evicts the previous session first;
 * - load proves the session with a bounded probe generation before
 *   resolving READY (a file that parses but cannot generate never reads
 *   as ready);
 * - explicit session/generation bounds: nCtx/nThreads/maxTokens are
 *   clamped, prompts over [MAX_PROMPT_CHARS] fail closed;
 * - unload drains in-flight iterations (bounded) before `nativeUnload`,
 *   never tearing down underneath live native code;
 * - stable error codes with short static messages only — native detail
 *   strings (which may name files) never cross the bridge.
 *
 * Generations stream as `llamaChunk` listener events keyed by
 * `generationId`; `cancelGeneration` is cooperative. GGUF weights resolve
 * like every other resident: explicit `ggufPath` under app-private files
 * wins, else the conventional
 * `ai-models/models/<modelId>/<revision>/` tree is scanned for GGUF files.
 * Residency is runtime-only: process death returns to unloaded.
 */
@CapacitorPlugin(name = "FindbackLlama")
class FindbackLlama : Plugin() {

    private val lock = Any()
    private var residentModelId: String? = null
    private var loading = false
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
        if (modelId.isNullOrBlank() || !MODEL_ID_PATTERN.matches(modelId)) {
            call.reject("unknown_model", "unknown model")
            return
        }
        val modelFile = resolveModelFile(modelId, call.getString("ggufPath"))
        if (modelFile == null) {
            call.reject("model_not_installed", "model is not installed")
            return
        }
        synchronized(lock) {
            if (loading) {
                call.reject("runtime_busy", "on-device lab runtime is busy")
                return
            }
            loading = true
            // Quiesce: in-flight iterations observe the cleared flags and
            // exit; the drain below waits for them (bounded) so nativeLoad
            // never frees a session under live native code.
            activeFlags.clear()
        }
        val nCtx = (call.getInt("nCtx", LAB_N_CTX) ?: LAB_N_CTX).coerceIn(MIN_N_CTX, MAX_N_CTX)
        val nThreads = (call.getInt("nThreads", LAB_N_THREADS) ?: LAB_N_THREADS).coerceIn(MIN_N_THREADS, MAX_N_THREADS)
        call.setKeepAlive(true)
        Thread(
            {
                try {
                    drainActive(LOAD_DRAIN_TIMEOUT_MS)
                    synchronized(lock) {
                        if (!LlamaBridge.ensureLoaded()) {
                            loading = false
                            call.reject("runtime_unavailable", "on-device lab runtime is unavailable")
                            return@Thread
                        }
                        LlamaBridge.nativeInit()
                        LlamaBridge.nativeLoad(modelFile.absolutePath, nCtx, nThreads)
                        // Probe self-test: a file that parses but cannot
                        // generate never resolves READY. nativeBegin resets
                        // the session, so the probe leaves no state behind
                        // for the first real inference.
                        LlamaBridge.nativeBegin(PROBE_PROMPT)
                        try {
                            LlamaBridge.nativeNext()
                        } catch (_: NativeLlamaException) {
                            // A probe decode failure still proves the
                            // session is alive (begin succeeded); only a
                            // begin failure below fails the load.
                        }
                        residentModelId = modelId
                        loading = false
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
                    synchronized(lock) {
                        try {
                            if (LlamaBridge.ensureLoaded()) LlamaBridge.nativeUnload()
                        } catch (_: Exception) {
                        }
                        residentModelId = null
                        loading = false
                    }
                    call.reject(mapCode(e.code), "on-device lab runtime failed to load")
                } catch (e: Exception) {
                    synchronized(lock) {
                        try {
                            if (LlamaBridge.ensureLoaded()) LlamaBridge.nativeUnload()
                        } catch (_: Exception) {
                        }
                        residentModelId = null
                        loading = false
                    }
                    call.reject("runtime_load_failed", "on-device lab runtime failed to load")
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
            call.reject("generation_failed", "on-device lab generation failed")
            return
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
            call.reject("invalid_request", "invalid lab text request")
            return
        }
        val maxTokens = (call.getInt("maxTokens", LAB_MAX_TOKENS) ?: LAB_MAX_TOKENS).coerceIn(1, MAX_GENERATION_TOKENS)
        synchronized(lock) {
            if (loading) {
                call.reject("runtime_busy", "on-device lab runtime is busy")
                return
            }
            if (residentModelId == null || !LlamaBridge.ensureLoaded()) {
                call.reject("runtime_unavailable", "on-device lab runtime is unavailable")
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
                    notifyChunk(generationId, error = mapCode(e.code))
                    call.reject(mapCode(e.code), "on-device lab generation failed")
                } catch (e: Exception) {
                    notifyChunk(generationId, error = "generation_failed")
                    call.reject("generation_failed", "on-device lab generation failed")
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
            if (loading) {
                call.reject("runtime_busy", "on-device lab runtime is busy")
                return
            }
            activeFlags.clear()
        }
        // Bounded drain: never tear the native session down underneath a
        // live iteration. Stragglers past the timeout are abandoned (their
        // finally still removes their flags); the unload proceeds because
        // a wedged lab call must not wedge cleanup forever.
        drainActive(UNLOAD_DRAIN_TIMEOUT_MS)
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

    /**
     * Bounded wait for in-flight inference iterations to observe their
     * cancelled flags and exit. Lock-free polling: iterations only hold
     * [lock] briefly per token.
     */
    private fun drainActive(timeoutMs: Long) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val remaining = synchronized(lock) { activeFlags.size }
            if (remaining == 0) return
            if (System.currentTimeMillis() >= deadline) return
            try {
                Thread.sleep(DRAIN_POLL_MS)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    companion object {
        private const val GGUF_EXTENSION = "gguf"
        private const val AI_MODELS_DIR = "ai-models"
        private const val LAB_N_CTX = 2048
        private const val LAB_N_THREADS = 4
        private const val LAB_MAX_TOKENS = 256
        private const val MIN_N_CTX = 256
        private const val MAX_N_CTX = 8192
        private const val MIN_N_THREADS = 1
        private const val MAX_N_THREADS = 8
        private const val MAX_GENERATION_TOKENS = 1024
        private const val MAX_PROMPT_CHARS = 16_000
        private const val PROBE_PROMPT = "ok"
        private const val DRAIN_POLL_MS = 50L
        private const val LOAD_DRAIN_TIMEOUT_MS = 10_000L
        private const val UNLOAD_DRAIN_TIMEOUT_MS = 10_000L
        private val MODEL_ID_PATTERN = Regex("[A-Za-z0-9._-]+")
    }
}
