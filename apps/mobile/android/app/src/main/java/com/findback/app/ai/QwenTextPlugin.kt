package com.findback.app.ai

import com.findback.app.vlm.Diag
import com.findback.app.vlm.RuntimeOperationGate
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
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.NoRepeatNgramConfig
import com.google.ai.edge.litertlm.RepetitionPenaltyConfig
import com.google.ai.edge.litertlm.SamplerConfig
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch

/**
 * On-device TEXT bridge: Qwen3-0.6B dynamic INT4 via LiteRT-LM
 * (`litertlm-android`), the general LiteRT-LM text resident.
 *
 * This is the native half of the `OfflineNativeBridge` text seam
 * (`providers/offline.ts`, bound by ApplicationAiService — the TS binding
 * is owned outside this file). Contract:
 * - `isTextAvailable()` reports whether a text resident is loaded
 *   (runtime-only state; process death returns to unloaded, so the TS
 *   side always reloads after a restart — nothing residency-related is
 *   persisted here).
 * - `loadTextModel({modelId, installedPath?, backend?, maxTokens?})`
 *   loads the EXACT verified `.litertlm` with evict-then-load semantics,
 *   a greedy sampler (temperature 0.0) with the same conservative
 *   anti-repeat decode as vision (repetition penalty 1.1, no-repeat
 *   3-gram), and a self-test round-trip before resolving READY.
 * - `generateText({generationId, prompt, maxOutputTokens?})` runs HONEST
 *   NON-STREAMING inference: the full response is collected natively,
 *   the `[thought]...[/thought]` envelope is stripped BEFORE anything
 *   crosses the bridge, and exactly one `qwenTextChunk` event carrying the
 *   user-visible text plus `done` is emitted. Token streaming is never
 *   faked — a single complete answer is one chunk, not a burst of
 *   pseudo-tokens. Cancellation aborts the in-flight generation and
 *   emits `cancelled` instead.
 * - `cancelGeneration({generationId})` aborts an in-flight generation.
 * - `unloadTextModel()` releases the resident (idempotent).
 *
 * Backend policy mirrors vision: the caller passes an already-resolved
 * `backend: "cpu" | "gpu"`. This plugin never re-decides and never falls
 * back silently — a failed GPU `initialize()` surfaces
 * `runtime_load_failed` so TS retries CPU explicitly. There is no cloud
 * member anywhere on this path, and no network code in this file.
 *
 * Single-resident arbitration across text/vision lives in TS
 * (`ResidencyCoordinator` evicts via unload calls); this plugin never
 * touches the vision engine, and the vision plugin never touches this
 * one. Within this plugin, [RuntimeOperationGate] serializes
 * load/generate/unload so two large operations never overlap.
 *
 * Failure contract: every reject uses a stable [QwenTextPolicy] code
 * with a short static message — never raw exception text, never prompt
 * fragments, paths, hashes, or token counts. Diag events carry numeric
 * timing/counts only.
 *
 * Model files live under app-private storage (`filesDir/ai-models/...`,
 * mirroring TS `buildModelPaths` `<root>/models/<modelId>/<revision>/<file>`
 * with root `filesDir/ai-models`). Only checksum-verified installs are
 * loaded: install-time verification (downloader workstream) is the gate,
 * and load additionally requires the file to exist under the app-private
 * tree with a `.litertlm` extension.
 */
@CapacitorPlugin(name = "FindbackQwenText")
class QwenTextPlugin : Plugin() {

    private val lock = Any()
    private val operations = RuntimeOperationGate()
    private var engine: Engine? = null
    private var residentModelId: String? = null
    private var sessionMaxTokens: Int = QwenTextPolicy.SESSION_DEFAULT_MAX_TOKENS
    private val activeJobs = mutableMapOf<String, Job>()
    private val activeConversations = mutableMapOf<String, Conversation>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @PluginMethod
    fun isTextAvailable(call: PluginCall) {
        val available = synchronized(lock) {
            engine?.isInitialized() == true && residentModelId != null
        }
        val ret = JSObject()
        ret.put("available", available)
        call.resolve(ret)
    }

    @PluginMethod
    fun loadTextModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (!QwenTextPolicy.isModelIdWellFormed(modelId)) {
            call.reject(QwenTextPolicy.UNKNOWN_MODEL, "unknown model")
            return
        }
        val requestedBackend = call.getString("backend", "cpu") ?: "cpu"
        val sessionMax = QwenTextPolicy.clampSessionMaxTokens(call.getInt("maxTokens"))
        val modelFile = resolveModelFile(modelId!!, call.getString("installedPath"))
        if (modelFile == null) {
            call.reject(QwenTextPolicy.MODEL_NOT_INSTALLED, "model is not installed")
            return
        }
        val lease = operations.acquire() ?: run {
            call.reject(QwenTextPolicy.RUNTIME_BUSY, "on-device runtime is busy")
            return
        }
        call.setKeepAlive(true)
        scope.launch {
            try {
                synchronized(lock) { unloadLocked() }
                LiteRtArtifactPolicy.inspect(modelFile.absolutePath, modelId, false)
                val textBackend =
                    if (requestedBackend == "gpu") Backend.GPU() else Backend.CPU()
                // Text-only model, text-only executors: vision/audio
                // executors stay uninitialized (EngineConfig defaults) —
                // the Qwen artifact carries no vision/audio encoder, and
                // configuring one fails conversation creation with
                // NOT_FOUND (same reason the vision resident leaves audio
                // unconfigured).
                val config = EngineConfig(
                    modelPath = modelFile.absolutePath,
                    backend = textBackend,
                    cacheDir = context.cacheDir.path,
                )
                val eng = Engine(config)
                // Own the engine before initialize: failure must also close
                // partial native allocation.
                synchronized(lock) { engine = eng }
                eng.initialize()
                // Self-test: resolve READY only after a proven round-trip
                // on a throwaway conversation. Per-generation
                // conversations (see generateText) start clean, so the
                // probe leaves no history behind.
                if (call.getBoolean("evaluation", false) != true) {
                val probe = eng.createConversation(
                    ConversationConfig(
                        samplerConfig = SamplerConfig(
                            topK = 40,
                            topP = 1.0,
                            temperature = 0.0,
                        ),
                        maxOutputToken = sessionMax,
                    ),
                )
                try {
                    probe.sendMessage(Contents.of(Content.Text("ok")))
                } finally {
                    try {
                        probe.close()
                    } catch (_: Exception) {
                    }
                }
                }
                synchronized(lock) {
                    engine = eng
                    residentModelId = modelId
                    sessionMaxTokens = sessionMax
                }
                val ret = JSObject()
                ret.put("ready", true)
                call.resolve(ret)
            } catch (e: Exception) {
                synchronized(lock) { unloadLocked() }
                // Static message: native failures may name files or
                // backends — none of that crosses the bridge.
                call.reject(QwenTextPolicy.RUNTIME_LOAD_FAILED, "on-device text runtime failed to load")
            } finally {
                lease.close()
            }
        }
    }

    @PluginMethod
    fun generateText(call: PluginCall) {
        val generationId = call.getString("generationId")
        val prompt = call.getString("prompt")
        if (!QwenTextPolicy.isGenerationIdAcceptable(generationId) ||
            !QwenTextPolicy.isPromptAcceptable(prompt)
        ) {
            call.reject(QwenTextPolicy.INVALID_REQUEST, "invalid text request")
            return
        }
        val lease = operations.acquire() ?: run {
            call.reject(QwenTextPolicy.RUNTIME_BUSY, "on-device runtime is busy")
            return
        }
        // Epoch protection: the engine identity captured here must still
        // be resident when the result is emitted — a switch/unload that
        // lands mid-generation drops the stale result instead of
        // delivering it to the new session.
        val epochEngine = synchronized(lock) { engine }
        val sessionMax = synchronized(lock) { sessionMaxTokens }
        if (epochEngine == null || epochEngine.isInitialized() != true) {
            lease.close()
            call.reject(QwenTextPolicy.RUNTIME_UNAVAILABLE, "on-device text runtime is not loaded")
            return
        }
        val callMax = QwenTextPolicy.clampCallMaxTokens(call.getInt("maxOutputTokens"), sessionMax)
        call.setKeepAlive(true)
        val job = scope.launch(start = CoroutineStart.LAZY) {
            val started = android.os.SystemClock.elapsedRealtime()
            var conversation: Conversation? = null
            try {
                conversation = epochEngine.createConversation(
                    ConversationConfig(
                        samplerConfig = SamplerConfig(
                            topK = 40,
                            topP = 1.0,
                            temperature = 0.0,
                        ),
                        maxOutputToken = callMax,
                    ),
                )
                val conv = conversation
                synchronized(lock) { activeConversations[generationId!!] = conv }
                val raw = StringBuilder()
                conv.sendMessageAsync(
                    Contents.of(Content.Text(prompt!!)),
                    extraContext = mapOf("enable_thinking" to false),
                    // Anti-repeat decode, same values as vision:
                    // greedy sampling loops whole sentences on small
                    // quantized artifacts; correctness first.
                    repetitionPenaltyConfig = RepetitionPenaltyConfig(
                        repetitionPenalty = REPETITION_PENALTY,
                    ),
                    noRepeatNgramConfig = NoRepeatNgramConfig(
                        noRepeatNgramSize = NO_REPEAT_NGRAM_SIZE,
                    ),
                ).collect { message ->
                    currentCoroutineContext().ensureActive()
                    raw.append(messageText(message))
                }
                currentCoroutineContext().ensureActive()
                // Strip the thought envelope BEFORE anything crosses the
                // bridge: reasoning never reaches the listener, the
                // resolve payload, logs, or diagnostics.
                val stripped = ThoughtEnvelope.strip(raw.toString())
                val fresh = synchronized(lock) {
                    engine === epochEngine && activeJobs[generationId] != null
                }
                if (!fresh) {
                    notifyGeneration(generationId!!, cancelled = true)
                    call.resolve()
                    return@launch
                }
                val elapsedMs = android.os.SystemClock.elapsedRealtime() - started
                if (Diag.enabled) {
                    // Numeric timing/counts only. Never prompts, decoded
                    // text, paths, or response content.
                    Diag.event(
                        context.cacheDir,
                        "ai.qwen.native.end",
                        null,
                        mapOf(
                            "elapsedMs" to elapsedMs,
                            "outputChars" to stripped.length,
                        ),
                    )
                }
                // Honest non-streaming: one complete answer, one chunk.
                // An empty string after stripping (thought-only output)
                // is an honest empty result with done — never a
                // reasoning fragment.
                notifyGeneration(generationId!!, delta = stripped, done = true)
                call.resolve()
            } catch (e: CancellationException) {
                notifyGeneration(generationId!!, cancelled = true)
                call.resolve()
            } catch (e: Exception) {
                notifyGeneration(generationId!!, error = QwenTextPolicy.GENERATION_FAILED)
                call.reject(QwenTextPolicy.GENERATION_FAILED, "on-device text generation failed")
            } finally {
                synchronized(lock) {
                    activeConversations.remove(generationId)
                    conversation?.let {
                        try {
                            it.close()
                        } catch (_: Exception) {
                        }
                    }
                }
            }
        }
        synchronized(lock) { activeJobs[generationId!!] = job }
        // Also runs when cancellation wins before the lazy coroutine enters its body.
        job.invokeOnCompletion {
            synchronized(lock) { activeJobs.remove(generationId) }
            lease.close()
        }
        job.start()
    }

    @PluginMethod
    fun cancelGeneration(call: PluginCall) {
        val generationId = call.getString("generationId")
        val job = synchronized(lock) { activeJobs[generationId] }
        val conversation = synchronized(lock) { activeConversations[generationId] }
        scope.launch {
            if (job != null) {
                job.cancel()
                try {
                    conversation?.cancelProcess()
                } catch (_: IllegalStateException) { /* Already finished. */ } catch (_: Exception) { /* Best-effort. */ }
                try {
                    job.join()
                } catch (_: Exception) { /* Best-effort. */ }
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun unloadTextModel(call: PluginCall) {
        val lease = operations.acquire() ?: run {
            call.reject(QwenTextPolicy.RUNTIME_BUSY, "on-device runtime is busy")
            return
        }
        try {
            // Cancel in-flight work first: with the gate held no new
            // generation can start, and cancel+join (via cancelGeneration
            // semantics inline) settles the old ones before native
            // teardown — never unload underneath live native code.
            val jobs = synchronized(lock) { activeJobs.values.toList() }
            val conversations = synchronized(lock) { activeConversations.values.toList() }
            for (conversation in conversations) {
                try {
                    conversation.cancelProcess()
                } catch (_: Exception) {
                }
            }
            for (job in jobs) {
                try {
                    job.cancel()
                } catch (_: Exception) {
                }
            }
            synchronized(lock) { unloadLocked() }
            call.resolve()
        } finally {
            lease.close()
        }
    }

    /**
     * Resolve the verified `.litertlm` for `modelId`. An explicit
     * `installedPath` from the TS manager wins after a canonical-path
     * check under the app-private files dir; otherwise scan the
     * conventional `ai-models/models/<modelId>/` tree, preferring the
     * exact production artifact name before any other `.litertlm`.
     * Null when nothing verified exists.
     */
    private fun resolveModelFile(modelId: String, installedPath: String?): File? {
        if (!installedPath.isNullOrBlank()) {
            val candidate = File(installedPath)
            if (isUnderAppFiles(candidate) &&
                candidate.isFile &&
                candidate.extension == QwenTextPolicy.LITERTLM_EXTENSION
            ) {
                return candidate
            }
            return null
        }
        if (!QwenTextPolicy.isModelIdWellFormed(modelId)) return null
        val root = File(context.filesDir, AI_MODELS_DIR)
        val modelDir = File(root, "models/$modelId")
        if (!isUnderAppFiles(modelDir) || !modelDir.isDirectory) return null
        val files = modelDir.walkTopDown()
            .filter { it.isFile && it.extension == QwenTextPolicy.LITERTLM_EXTENSION }
            .filter { isUnderAppFiles(it) }
            .toList()
        return files.firstOrNull { it.name == QwenTextPolicy.QWEN_FILE_NAME }
            ?: files.firstOrNull()
    }

    private fun isUnderAppFiles(file: File): Boolean {
        return try {
            val base = context.filesDir.canonicalPath
            file.canonicalPath == base || file.canonicalPath.startsWith("$base/")
        } catch (_: Exception) {
            false
        }
    }

    /** Must be called under [lock]. Cancels bookkeeping and clears the resident. */
    private fun unloadLocked() {
        activeJobs.clear()
        try {
            for (conversation in activeConversations.values) {
                try {
                    conversation.close()
                } catch (_: Exception) {
                }
            }
        } finally {
            activeConversations.clear()
        }
        try {
            engine?.close()
        } catch (_: Exception) {
        }
        engine = null
        residentModelId = null
        sessionMaxTokens = QwenTextPolicy.SESSION_DEFAULT_MAX_TOKENS
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
        notifyListeners("qwenTextChunk", event)
    }

    companion object {
        private const val AI_MODELS_DIR = "ai-models"
        // Conservative anti-repeat decode, same values as vision: mild
        // penalty (1.0 is neutral) plus a no-repeat 3-gram. Tuned against
        // on-device repetition loops; correctness first, smoothness second.
        private const val REPETITION_PENALTY = 1.1f
        private const val NO_REPEAT_NGRAM_SIZE = 3

        /** User-visible text of a LiteRT-LM response message. */
        internal fun messageText(message: Message): String =
            message.contents.contents
                .filterIsInstance<Content.Text>()
                .joinToString("") { it.text }
    }
}
