package com.findback.app.vlm

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

/**
 * On-device vision bridge: SmolVLM2-500M via LiteRT-LM (`litertlm-android`).
 *
 * Real implementation (was a `vision_unsupported` stub until the A-wave):
 * - `isVisionAvailable()` reports whether an image-capable resident is
 *   loaded (runtime-only state; process death returns to unloaded).
 * - `loadVisionModel()` loads a verified `.litertlm` file with evict-then-load
 *   single-resident semantics, a greedy sampler (temperature 0.0), and a
 *   self-test before resolving READY.
 * - `describeImage()` streams vision inference as `visionChunk` listener
 *   events keyed by `generationId`, honouring cancellation.
 * - `cancelGeneration()` aborts an in-flight generation.
 * - `unloadVisionModel()` releases the resident (idempotent).
 *
 * Backend policy (selector of record is TS `vision/backendSelector.ts`):
 * the caller passes `backend: "cpu" | "gpu"` already resolved against fresh
 * [GpuProbePassRecord] evidence. This plugin never re-decides and never
 * falls back silently — a failed GPU `initialize()` surfaces
 * `runtime_load_failed` so TS retries CPU explicitly. There is no cloud
 * member anywhere on this path.
 *
 * Model files live under app-private storage (`filesDir/ai-models/...`,
 * mirroring TS `buildModelPaths` `<root>/models/<modelId>/<revision>/<file>`
 * with root `filesDir/ai-models`). Only checksum-verified installs are
 * loaded: install-time verification (downloader workstream) is the gate,
 * and load additionally requires the file to exist under the app-private
 * tree with a `.litertlm` extension. Image bytes stay behind the bridge —
 * they are decoded and fed to LiteRT-LM here, never logged.
 */
@CapacitorPlugin(name = "FindbackSmolVlm")
class SmolVlmPlugin : Plugin() {

    private val lock = Any()
    private var engine: Engine? = null
    private var conversation: Conversation? = null
    private var residentModelId: String? = null
    private val activeJobs = mutableMapOf<String, Job>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @PluginMethod
    fun isVisionAvailable(call: PluginCall) {
        val available = synchronized(lock) {
            engine?.isInitialized() == true && conversation?.isAlive == true
        }
        val ret = JSObject()
        ret.put("available", available)
        call.resolve(ret)
    }

    @PluginMethod
    fun loadVisionModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId.isNullOrBlank()) {
            call.reject("unknown_model")
            return
        }
        val requestedBackend = call.getString("backend", "cpu") ?: "cpu"
        val maxOutputTokens = call.getInt("maxOutputTokens", DEFAULT_MAX_OUTPUT_TOKENS)
            ?: DEFAULT_MAX_OUTPUT_TOKENS
        val modelFile = resolveModelFile(modelId, call.getString("installedPath"))
        if (modelFile == null) {
            call.reject("model_not_installed")
            return
        }
        call.setKeepAlive(true)
        scope.launch {
            try {
                synchronized(lock) { unloadLocked() }
                val visionBackend =
                    if (requestedBackend == "gpu") Backend.GPU() else Backend.CPU()
                val config = EngineConfig(
                    modelPath = modelFile.absolutePath,
                    backend = Backend.CPU(),
                    visionBackend = visionBackend,
                    audioBackend = Backend.CPU(),
                    cacheDir = context.cacheDir.path,
                )
                val eng = Engine(config)
                eng.initialize()
                val conv = eng.createConversation(
                    ConversationConfig(
                        samplerConfig = SamplerConfig(
                            topK = 40,
                            topP = 1.0,
                            temperature = 0.0,
                        ),
                        maxOutputToken = maxOutputTokens,
                    ),
                )
                // Self-test: resolve READY only after a proven round-trip.
                conv.sendMessage(Contents.of(Content.Text("ok")))
                synchronized(lock) {
                    engine = eng
                    conversation = conv
                    residentModelId = modelId
                }
                val ret = JSObject()
                ret.put("ready", true)
                call.resolve(ret)
            } catch (e: Exception) {
                synchronized(lock) { unloadLocked() }
                call.reject("runtime_load_failed", e.message?.take(400))
            }
        }
    }

    @PluginMethod
    fun describeImage(call: PluginCall) {
        val generationId = call.getString("generationId")
        val imageBase64 = call.getString("imageBase64")
        if (generationId.isNullOrBlank() || imageBase64.isNullOrBlank()) {
            call.reject("generation_failed")
            return
        }
        val prompt = call.getString("prompt", DEFAULT_VISION_PROMPT) ?: DEFAULT_VISION_PROMPT
        val conv = synchronized(lock) { conversation }
        if (conv == null || conv.isAlive != true) {
            call.reject("vision_unsupported")
            return
        }
        call.setKeepAlive(true)
        val job = scope.launch {
            try {
                val bytes = Base64.decode(imageBase64, Base64.DEFAULT)
                conv.sendMessageAsync(
                    Contents.of(
                        Content.ImageBytes(bytes),
                        Content.Text(prompt),
                    ),
                ).catch { e ->
                    notifyGeneration(generationId, error = e.message?.take(400))
                    call.reject("generation_failed")
                }.collect { message ->
                    notifyGeneration(generationId, delta = message.toString())
                }
                notifyGeneration(generationId, done = true)
                call.resolve()
            } catch (e: CancellationException) {
                notifyGeneration(generationId, cancelled = true)
                call.resolve()
            } catch (e: Exception) {
                notifyGeneration(generationId, error = e.message?.take(400))
                call.reject("generation_failed")
            } finally {
                synchronized(lock) { activeJobs.remove(generationId) }
            }
        }
        synchronized(lock) { activeJobs[generationId] = job }
    }

    @PluginMethod
    fun cancelGeneration(call: PluginCall) {
        val generationId = call.getString("generationId")
        synchronized(lock) { activeJobs.remove(generationId) }?.cancel()
        try {
            synchronized(lock) { conversation }?.cancelProcess()
        } catch (_: IllegalStateException) {
            // No live conversation — nothing to cancel natively.
        }
        call.resolve()
    }

    @PluginMethod
    fun unloadVisionModel(call: PluginCall) {
        synchronized(lock) {
            activeJobs.values.forEach { it.cancel() }
            activeJobs.clear()
            unloadLocked()
        }
        call.resolve()
    }

    /**
     * Resolve the verified `.litertlm` for `modelId`. An explicit
     * `installedPath` from the TS manager wins after a canonical-path
     * check under the app-private files dir; otherwise scan the
     * conventional `ai-models/models/<modelId>/` tree for the first
     * `.litertlm` file. Null when nothing verified exists.
     */
    private fun resolveModelFile(modelId: String, installedPath: String?): File? {
        if (!installedPath.isNullOrBlank()) {
            val candidate = File(installedPath)
            if (isUnderAppFiles(candidate) &&
                candidate.isFile &&
                candidate.extension == LITERTLM_EXTENSION
            ) {
                return candidate
            }
            return null
        }
        if (!MODEL_ID_PATTERN.matches(modelId)) return null
        val root = File(context.filesDir, AI_MODELS_DIR)
        val modelDir = File(root, "models/$modelId")
        if (!isUnderAppFiles(modelDir) || !modelDir.isDirectory) return null
        return modelDir.walkTopDown()
            .firstOrNull { it.isFile && it.extension == LITERTLM_EXTENSION }
            ?.takeIf { isUnderAppFiles(it) }
    }

    private fun isUnderAppFiles(file: File): Boolean {
        return try {
            val base = context.filesDir.canonicalPath
            file.canonicalPath == base || file.canonicalPath.startsWith("$base/")
        } catch (_: Exception) {
            false
        }
    }

    /** Must be called under [lock]. Closes and clears the resident. */
    private fun unloadLocked() {
        try {
            conversation?.close()
        } catch (_: Exception) {
        }
        try {
            engine?.close()
        } catch (_: Exception) {
        }
        conversation = null
        engine = null
        residentModelId = null
    }

    private fun notifyGeneration(
        generationId: String,
        delta: String? = null,
        done: Boolean = false,
        cancelled: Boolean = false,
        error: String? = null,
    ) {
        val event = JSObject()
        event.put("generationId", generationId)
        if (delta != null) event.put("textDelta", delta)
        if (done) event.put("done", true)
        if (cancelled) event.put("cancelled", true)
        if (error != null) event.put("error", error)
        notifyListeners("visionChunk", event)
    }

    companion object {
        private const val LITERTLM_EXTENSION = "litertlm"
        private const val AI_MODELS_DIR = "ai-models"
        private const val DEFAULT_MAX_OUTPUT_TOKENS = 512
        private const val DEFAULT_VISION_PROMPT = "Describe this image."
        private val MODEL_ID_PATTERN = Regex("[A-Za-z0-9._-]+")
    }
}
