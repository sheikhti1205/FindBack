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
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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
    private val operations = RuntimeOperationGate()
    private var engine: Engine? = null
    private var conversation: Conversation? = null
    private var residentModelId: String? = null
    private val activeJobs = mutableMapOf<String, Job>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @PluginMethod
    fun collectDeviceFacts(call: PluginCall) {
        scope.launch {
            val facts = DeviceProbe.collectFacts(DeviceProbe.RealProviders(context))
            if (facts == null) { call.reject("device_facts_unavailable"); return@launch }
            val result = JSObject()
            result.put("socModel", facts.socModel)
            result.put("gpuInfo", facts.gpuInfo)
            result.put("ramMb", facts.ramMb)
            result.put("osVersion", facts.osVersion)
            result.put("nnapiStatus", facts.nnapiStatus)
            result.put("vulkanStatus", facts.vulkanStatus)
            result.put("openClStatus", facts.openClStatus)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun measureBackend(call: PluginCall) {
        val backend = call.getString("backend")
        val expectedFile = RuntimeTimingRunner.installedFile(context)
        if (backend !in listOf("cpu", "gpu") ||
            call.getString("modelId") != RuntimeTimingRunner.MODEL_ID ||
            call.getString("modelRev") != RuntimeTimingRunner.MODEL_REV ||
            call.getString("corpusVersion") != RuntimeTimingRunner.CORPUS_VERSION ||
            call.getString("installedPath") != expectedFile.absolutePath
        ) { call.reject("invalid_probe_identity"); return }
        val lease = operations.acquire() ?: run { call.reject("runtime_busy"); return }
        scope.launch {
            try {
                synchronized(lock) {
                    if (activeJobs.isNotEmpty()) { call.reject("runtime_busy"); return@launch }
                    unloadLocked()
                }
                // Phase A (Step 9): discriminated measurement errors. A failed
                // measurement never gates CPU inference (TS keeps serving CPU
                // and auto-GPU still requires valid measured evidence) — these
                // codes exist so diagnostics can tell "benchmark off" from
                // "engine crashed" instead of one timing_unavailable collapse.
                when (val outcome = DeviceProbe.collectDetailed(backend!!, RuntimeTimingRunner.MODEL_REV,
                    RuntimeTimingRunner.CORPUS_VERSION, DeviceProbe.RealProviders(context))) {
                    is DeviceProbe.ProbeOutcome.Measured -> {
                        val record = outcome.record
                        val sample = JSObject()
                        sample.put("socModel", record.socModel)
                        sample.put("gpuInfo", record.gpuInfo)
                        sample.put("ramMb", record.ramMb)
                        sample.put("osVersion", record.osVersion)
                        sample.put("backend", record.backend)
                        sample.put("ttftMs", record.ttftMs)
                        sample.put("tokensPerSec", record.tokensPerSec)
                        sample.put("corpusVersion", record.corpusVersion)
                        sample.put("probeVersion", record.probeVersion)
                        sample.put("modelRev", record.modelRev)
                        sample.put("correctnessPass", record.correctnessPass)
                        val result = JSObject()
                        result.put("record", sample)
                        call.resolve(result)
                    }
                    is DeviceProbe.ProbeOutcome.Failed -> call.reject(benchmarkRejectCode(outcome.reason), outcome.detail)
                }
            } catch (e: Exception) { call.reject("measurement_failed", e.message?.take(400)) }
            finally { lease.close() }
        }
    }

    /**
     * Phase A (Step 9): one reject code per benchmark failure cause.
     * `benchmark_unavailable` (flag off / no counters / no runner) and
     * `device_facts_unavailable` mean "measurement impossible" — TS must
     * keep CPU inference usable and say so. Everything else is a genuine
     * runtime or install problem.
     */
    private fun benchmarkRejectCode(reason: DeviceProbe.BenchmarkFailure): String = when (reason) {
        DeviceProbe.BenchmarkFailure.UNKNOWN_BACKEND -> "invalid_probe_identity"
        DeviceProbe.BenchmarkFailure.MODEL_MISSING_OR_UNVERIFIED -> "model_not_installed"
        DeviceProbe.BenchmarkFailure.ENGINE_INIT_FAILED -> "runtime_init_failed"
        DeviceProbe.BenchmarkFailure.INFERENCE_TIMEOUT -> "inference_timeout"
        DeviceProbe.BenchmarkFailure.COUNTERS_UNAVAILABLE -> "benchmark_unavailable"
        DeviceProbe.BenchmarkFailure.COUNTERS_INVALID -> "benchmark_counters_invalid"
        DeviceProbe.BenchmarkFailure.FACTS_UNREADABLE -> "device_facts_unavailable"
        DeviceProbe.BenchmarkFailure.NO_TIMING_RUNNER -> "benchmark_unavailable"
    }

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
        val lease = operations.acquire() ?: run { call.reject("runtime_busy"); return }
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
                // Own the engine before initialize: failure must also close partial native allocation.
                synchronized(lock) { engine = eng }
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
                synchronized(lock) { conversation = conv }
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
            } finally { lease.close() }
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
        val lease = operations.acquire() ?: run { call.reject("runtime_busy"); return }
        val prompt = call.getString("prompt", DEFAULT_VISION_PROMPT) ?: DEFAULT_VISION_PROMPT
        val conv = synchronized(lock) { conversation }
        if (conv == null || conv.isAlive != true) {
            lease.close()
            call.reject("vision_unsupported")
            return
        }
        call.setKeepAlive(true)
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                val bytes = Base64.decode(imageBase64, Base64.DEFAULT)
                conv.sendMessageAsync(
                    Contents.of(
                        Content.ImageBytes(bytes),
                        Content.Text(prompt),
                    ),
                ).collect { message ->
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
            }
        }
        synchronized(lock) { activeJobs[generationId] = job }
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
        scope.launch {
            if (job != null) {
                job.cancel()
                try { synchronized(lock) { conversation }?.cancelProcess() }
                catch (_: IllegalStateException) { /* Already finished. */ }
                job.join()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun unloadVisionModel(call: PluginCall) {
        val lease = operations.acquire() ?: run { call.reject("runtime_busy"); return }
        try {
            synchronized(lock) { unloadLocked() }
            call.resolve()
        } finally { lease.close() }
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
