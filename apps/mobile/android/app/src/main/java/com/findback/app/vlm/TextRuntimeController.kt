package com.findback.app.vlm

/**
 * Bridge-facing outcome for an explicit-modelId text request. Pure data so
 * the plugin stays thin and every path is JVM-testable.
 */
sealed interface TextGenerateOutcome {
    data class Ok(val text: String, val backend: String, val elapsedMs: Long) : TextGenerateOutcome
    data class Err(val code: String, val message: String) : TextGenerateOutcome
}

/**
 * Self-test result for the text runtime. Activation succeeds only when
 * [ready] is true, which requires a real completed runtime init plus a
 * usable generation.
 */
data class TextSelfTestResult(
    val ready: Boolean,
    val state: String,
    val failure: SelfTestFailure? = null,
    val diagnostics: List<String> = emptyList()
)

/**
 * Diagnostics snapshot for the text runtime status read.
 */
data class TextRuntimeStatus(
    val modelId: String,
    val ready: Boolean,
    val nativeRunning: Boolean,
    val backend: String,
    val modelFilePresent: Boolean
)

/**
 * Orchestrates the qualified text runtime behind the explicit-modelId
 * bridge: model-id gating, single-flight generation, cancel, release with
 * deferral while native code runs, readiness gating, and diagnostics.
 *
 * The engine factory returns null when the model file is absent; the
 * file-presence probe backs the status read. Both are injected so tests
 * run on fakes with no device or runtime.
 */
class TextRuntimeController(
    private val engineFactory: () -> QwenTextEngine?,
    private val isModelInstalled: () -> Boolean,
    private val clock: () -> Long = System::currentTimeMillis
) {

    companion object {
        const val CODE_UNSUPPORTED_MODEL = "UNSUPPORTED_MODEL"
        const val CODE_MODEL_NOT_INSTALLED = "MODEL_NOT_INSTALLED"
        const val CODE_NOT_READY = "NOT_READY"
        const val CODE_BUSY = "BUSY"
        const val CODE_CANCELLED = "CANCELLED"
        const val CODE_GENERATION_ERROR = "GENERATION_ERROR"
        const val CODE_MODEL_RUNTIME_ERROR = "MODEL_RUNTIME_ERROR"

        const val STATE_READY = "TEXT_READY"
        const val STATE_UNAVAILABLE = "TEXT_UNAVAILABLE"
        const val STATE_UNSUPPORTED = "TEXT_UNSUPPORTED"
    }

    private val lock = Any()
    private var engine: QwenTextEngine? = null

    @Volatile
    private var nativeRunning = false

    @Volatile
    private var cancelled = false

    @Volatile
    private var deferredRelease = false

    fun isReady(): Boolean = synchronized(lock) { engine?.isReady == true }

    fun isNativeRunning(): Boolean = nativeRunning

    fun generateText(
        modelId: String?,
        prompt: String,
        maxOutputTokens: Int,
        temperature: Float,
        traceId: String? = null
    ): TextGenerateOutcome {
        if (!QwenTextRuntime.isAcceptedModelId(modelId)) {
            return TextGenerateOutcome.Err(
                CODE_UNSUPPORTED_MODEL,
                "Unsupported text model: ${modelId ?: "<null>"}. " +
                    "This runtime serves only \"${QwenTextRuntime.BRIDGE_MODEL_ID}\"."
            )
        }
        synchronized(lock) {
            if (nativeRunning) {
                return TextGenerateOutcome.Err(CODE_BUSY, "Text generation already in progress.")
            }
            nativeRunning = true
            cancelled = false
        }
        try {
            val resident = synchronized(lock) { engine } ?: run {
                val fresh = try {
                    engineFactory()
                } catch (e: Exception) {
                    return TextGenerateOutcome.Err(
                        CODE_MODEL_RUNTIME_ERROR,
                        "Text engine could not start: ${e.message}"
                    )
                } ?: return TextGenerateOutcome.Err(
                    CODE_MODEL_NOT_INSTALLED,
                    "Text model not installed."
                )
                synchronized(lock) {
                    val existing = engine
                    if (existing != null) {
                        try {
                            fresh.release()
                        } catch (_: Exception) {
                        }
                        existing
                    } else {
                        engine = fresh
                        fresh
                    }
                }
            }
            try {
                resident.initialize()
            } catch (e: Exception) {
                return TextGenerateOutcome.Err(
                    CODE_MODEL_RUNTIME_ERROR,
                    "Text runtime init failed: ${e.message}"
                )
            }
            if (cancelled) {
                return TextGenerateOutcome.Err(CODE_CANCELLED, "Text generation cancelled.")
            }
            val startMs = clock()
            return try {
                val text = resident.generateText(modelId, prompt, maxOutputTokens, temperature, traceId)
                if (cancelled) {
                    TextGenerateOutcome.Err(CODE_CANCELLED, "Text generation cancelled.")
                } else {
                    TextGenerateOutcome.Ok(text, resident.backendName, clock() - startMs)
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                TextGenerateOutcome.Err(CODE_CANCELLED, "Text generation cancelled.")
            } catch (e: IllegalStateException) {
                TextGenerateOutcome.Err(CODE_NOT_READY, e.message ?: "Text runtime is not ready.")
            } catch (e: IllegalArgumentException) {
                TextGenerateOutcome.Err(CODE_GENERATION_ERROR, e.message ?: "Invalid text request.")
            } catch (e: Exception) {
                TextGenerateOutcome.Err(CODE_GENERATION_ERROR, e.message ?: "Text generation failed.")
            }
        } finally {
            nativeRunning = false
            if (deferredRelease) {
                deferredRelease = false
                releaseEngineLocked()
            }
        }
    }

    /**
     * Best effort: flags the active generation cancelled and asks the host
     * to stop in-flight work. The eventual result is ignored; nothing is
     * unlocked early.
     */
    fun cancel() {
        cancelled = true
        synchronized(lock) {
            engine
        }?.cancel()
    }

    /**
     * Disposes the resident engine and clears readiness. While native code
     * runs the close is deferred until the generation settles instead of
     * closing underneath it.
     */
    fun release() {
        if (nativeRunning) {
            cancelled = true
            deferredRelease = true
            synchronized(lock) {
                engine
            }?.cancel()
            return
        }
        releaseEngineLocked()
    }

    fun runSelfTest(modelId: String?, prompt: String): TextSelfTestResult {
        if (!QwenTextRuntime.isAcceptedModelId(modelId)) {
            return TextSelfTestResult(
                ready = false,
                state = STATE_UNSUPPORTED,
                diagnostics = listOf("Unsupported text model: ${modelId ?: "<null>"}.")
            )
        }
        if (nativeRunning) {
            return TextSelfTestResult(
                ready = false,
                state = STATE_UNAVAILABLE,
                diagnostics = listOf("Text generation already in progress.")
            )
        }
        val resident = synchronized(lock) { engine } ?: run {
            val fresh = try {
                engineFactory()
            } catch (e: Exception) {
                return TextSelfTestResult(
                    ready = false,
                    state = STATE_UNAVAILABLE,
                    failure = SelfTestFailure.MODEL_RUNTIME_ERROR,
                    diagnostics = listOf("Text engine could not start: ${e.message}")
                )
            } ?: return TextSelfTestResult(
                ready = false,
                state = STATE_UNAVAILABLE,
                diagnostics = listOf("Text model not installed.")
            )
            synchronized(lock) {
                val existing = engine
                if (existing != null) {
                    try {
                        fresh.release()
                    } catch (_: Exception) {
                    }
                    existing
                } else {
                    engine = fresh
                    fresh
                }
            }
        }
        nativeRunning = true
        try {
            val outcome = resident.runSelfTest(prompt)
            return if (outcome.success) {
                TextSelfTestResult(
                    ready = true,
                    state = STATE_READY,
                    diagnostics = outcome.diagnostics
                )
            } else {
                TextSelfTestResult(
                    ready = false,
                    state = STATE_UNAVAILABLE,
                    failure = outcome.failure,
                    diagnostics = outcome.diagnostics
                )
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            return TextSelfTestResult(
                ready = false,
                state = STATE_UNAVAILABLE,
                diagnostics = listOf("Self-test cancelled.")
            )
        } finally {
            nativeRunning = false
            if (deferredRelease) {
                deferredRelease = false
                releaseEngineLocked()
            }
        }
    }

    fun status(): TextRuntimeStatus {
        val resident = synchronized(lock) { engine }
        return TextRuntimeStatus(
            modelId = QwenTextRuntime.BRIDGE_MODEL_ID,
            ready = resident?.isReady == true,
            nativeRunning = nativeRunning,
            backend = resident?.backendName ?: VlmEngineBackend.GPU.wire,
            modelFilePresent = try {
                isModelInstalled()
            } catch (_: Exception) {
                false
            }
        )
    }

    private fun releaseEngineLocked() {
        val stale = synchronized(lock) {
            val current = engine
            engine = null
            current
        }
        if (stale != null) {
            try {
                stale.release()
            } catch (_: Exception) {
            }
        }
    }
}
