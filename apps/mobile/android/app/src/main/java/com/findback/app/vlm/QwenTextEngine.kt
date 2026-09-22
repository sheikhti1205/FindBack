package com.findback.app.vlm

import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.CancellationException
import java.io.Closeable
import java.io.File

/**
 * Host behind [QwenTextEngine]: runtime construction, single generation,
 * in-flight cancel, and close. The production host drives LiteRT-LM;
 * tests inject a fake so no device or runtime is needed.
 */
interface QwenTextHost : Closeable {
    fun initialize()
    fun generate(prompt: String, maxOutputTokens: Int, temperature: Float): String
    fun cancelInFlight()
    override fun close()
}

/**
 * LiteRT-LM host for the qualified text artifact. Mirrors the VLM engine
 * construction (GPU preferred with an explicit CPU compatibility path,
 * same sampler shape) but runs text-only generations: one fresh
 * conversation per prompt, closed immediately after.
 */
class LiteRtQwenTextHost(
    modelPath: String,
    cacheDir: File,
    private val engineBackend: VlmEngineBackend = VlmEngineBackend.GPU
) : QwenTextHost {

    private var engine: Engine? = null

    @Volatile
    private var activeConversation: Conversation? = null
    private val config = EngineConfig(
        modelPath = modelPath,
        backend = if (engineBackend == VlmEngineBackend.CPU) Backend.CPU() else Backend.GPU(),
        visionBackend = if (engineBackend == VlmEngineBackend.CPU) Backend.CPU() else Backend.GPU(),
        audioBackend = null,
        maxNumTokens = 2048,
        maxNumImages = 1,
        cacheDir = cacheDir.absolutePath
    )

    override fun initialize() {
        val fresh = Engine(config)
        try {
            fresh.initialize()
        } catch (t: Throwable) {
            try {
                fresh.close()
            } catch (_: Exception) {
            }
            throw t
        }
        engine = fresh
    }

    override fun generate(prompt: String, maxOutputTokens: Int, temperature: Float): String {
        val engineInstance = engine
            ?: throw IllegalStateException("Host not initialized. Call initialize() first.")
        val conversation = engineInstance.createConversation(
            ConversationConfig(
                systemInstruction = Contents.of("You are a local text assistant for a lost-and-found report."),
                samplerConfig = SamplerConfig(
                    topK = 40,
                    topP = 0.95,
                    temperature = temperature.toDouble(),
                    seed = 0
                ),
                maxOutputToken = maxOutputTokens
            )
        )
        activeConversation = conversation
        try {
            val response = conversation.sendMessage(Contents.of(Content.Text(prompt)))
            return response.contents.contents
                .filterIsInstance<Content.Text>()
                .joinToString("") { it.text }
        } finally {
            activeConversation = null
            conversation.close()
        }
    }

    override fun cancelInFlight() {
        try {
            activeConversation?.cancelProcess()
        } catch (_: Exception) {
        }
    }

    override fun close() {
        activeConversation = null
        try {
            engine?.close()
        } catch (_: Exception) {
        }
        engine = null
    }
}

/**
 * Text-only engine for the qualified on-device text runtime.
 *
 * Readiness is observed, never assumed: [isReady] turns true only after
 * the host initializes without throwing, and [generateText] fails closed
 * otherwise. Cancel flips a flag plus the host in-flight cancel; release
 * closes the host and clears readiness so the next use re-initializes.
 */
class QwenTextEngine(
    private val hostFactory: () -> QwenTextHost,
    private val diagCacheDir: File?,
    val engineBackend: VlmEngineBackend = VlmEngineBackend.GPU,
    private val clock: () -> Long = System::currentTimeMillis
) {

    private val lock = Any()
    private var host: QwenTextHost? = null
    private var ready = false

    @Volatile
    private var cancelled = false

    val backendName: String get() = engineBackend.wire

    val isReady: Boolean get() = synchronized(lock) { ready }

    fun initialize() {
        synchronized(lock) {
            if (ready) return
        }
        val fresh = hostFactory()
        try {
            fresh.initialize()
        } catch (t: Throwable) {
            try {
                fresh.close()
            } catch (_: Exception) {
            }
            throw t
        }
        synchronized(lock) {
            val stale = host
            host = fresh
            ready = true
            cancelled = false
            if (stale != null) {
                try {
                    stale.close()
                } catch (_: Exception) {
                }
            }
        }
    }

    fun generateText(
        modelId: String?,
        prompt: String,
        maxOutputTokens: Int,
        temperature: Float,
        traceId: String? = null
    ): String {
        QwenTextRuntime.requireAcceptedModelId(modelId)
        require(prompt.isNotBlank()) { "Prompt must not be blank." }
        require(maxOutputTokens >= 1) { "maxOutputTokens must be at least 1." }
        val hostInstance = synchronized(lock) {
            if (!ready || host == null) {
                throw IllegalStateException("Engine not initialized. Call initialize() first.")
            }
            host!!
        }
        if (cancelled) throw CancellationException("Text generation cancelled.")
        val startMs = clock()
        try {
            val text = hostInstance.generate(prompt, maxOutputTokens, temperature)
            if (cancelled) throw CancellationException("Text generation cancelled.")
            Diag.event(
                diagCacheDir,
                "qwen.engine.generate.done",
                traceId,
                Diag.outputDigest(text) + mapOf(
                    "backend" to backendName,
                    "maxOutputTokens" to maxOutputTokens,
                    "temperature" to temperature,
                    "ms" to (clock() - startMs)
                )
            )
            return text
        } catch (e: CancellationException) {
            Diag.event(
                diagCacheDir,
                "qwen.engine.generate.cancelled",
                traceId,
                mapOf("backend" to backendName, "ms" to (clock() - startMs))
            )
            throw e
        } catch (e: Exception) {
            Diag.event(
                diagCacheDir,
                "qwen.engine.generate.error",
                traceId,
                mapOf(
                    "backend" to backendName,
                    "ms" to (clock() - startMs),
                    "error" to (e.message ?: "generate failed")
                )
            )
            throw e
        }
    }

    fun cancel() {
        cancelled = true
        synchronized(lock) {
            host
        }?.cancelInFlight()
    }

    fun release() {
        val stale = synchronized(lock) {
            val current = host
            host = null
            ready = false
            cancelled = false
            current
        }
        if (stale != null) {
            try {
                stale.close()
            } catch (_: Exception) {
            }
        }
    }

    fun runSelfTest(prompt: String): SelfTestOutcome {
        val diagnostics = mutableListOf<String>()
        try {
            initialize()
        } catch (e: Exception) {
            diagnostics.add("Text engine init failed: ${e.message}")
            return SelfTestOutcome(false, SelfTestFailure.MODEL_RUNTIME_ERROR, diagnostics.toList())
        }
        diagnostics.add("Text engine initialized with ${backendName} backend")
        return try {
            val result = generateText(QwenTextRuntime.BRIDGE_MODEL_ID, prompt, 64, 0.1f)
            diagnostics.add("Self-test generation completed: ${result.take(100)}")
            if (EnginePolicy.selfTestPassed(result)) {
                SelfTestOutcome(true, null, diagnostics.toList())
            } else {
                diagnostics.add("Self-test generation produced no usable output")
                SelfTestOutcome(false, SelfTestFailure.GENERATION_ERROR, diagnostics.toList())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            diagnostics.add("Self-test generation failed: ${e.message}")
            SelfTestOutcome(false, SelfTestFailure.GENERATION_ERROR, diagnostics.toList())
        }
    }
}
