package com.findback.app.ai

/**
 * Qwen/LiteRT-LM text seam policy: stable error codes plus explicit
 * session/generation limits (pure, JVM-testable, no Android deps).
 *
 * Error codes are the whole consumer contract: the plugin rejects with
 * these codes and short static messages only — never raw exception text,
 * never prompt fragments, paths, hashes, or token counts. TS maps codes
 * to consumer copy; unknown codes must never reach the UI.
 */
object QwenTextPolicy {
    const val UNKNOWN_MODEL = "unknown_model"
    const val MODEL_NOT_INSTALLED = "model_not_installed"
    const val RUNTIME_UNAVAILABLE = "runtime_unavailable"
    const val RUNTIME_BUSY = "runtime_busy"
    const val RUNTIME_LOAD_FAILED = "runtime_load_failed"
    const val GENERATION_FAILED = "generation_failed"
    const val INVALID_REQUEST = "invalid_request"

    /** Production Qwen3 0.6B artifact served by this bridge. */
    const val QWEN_MODEL_ID = "qwen3-0.6b-dynamic-int4"
    const val QWEN_FILE_NAME = "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm"
    const val LITERTLM_EXTENSION = "litertlm"

    /**
     * Session output-token ceiling fixed at load. The profile notes an
     * unverified litert-lm `--max-tokens 1024` session floor for Qwen, so
     * the floor here is 1024: smaller requests still open a 1024 session
     * and cap the single call instead.
     */
    const val SESSION_DEFAULT_MAX_TOKENS = 1024
    const val SESSION_MIN_MAX_TOKENS = 1024
    const val SESSION_MAX_MAX_TOKENS = 2048

    /** Longest prompt the bridge accepts (chars, fail-closed above). */
    const val MAX_PROMPT_CHARS = 16_000

    /** Model ids are path-segment-safe tokens only (never traversal). */
    private val MODEL_ID_PATTERN = Regex("[A-Za-z0-9._-]+")

    fun isModelIdWellFormed(modelId: String?): Boolean =
        !modelId.isNullOrBlank() && MODEL_ID_PATTERN.matches(modelId)

    /** Clamp a load-time session ceiling into the explicit session window. */
    fun clampSessionMaxTokens(requested: Int?): Int {
        val value = requested ?: SESSION_DEFAULT_MAX_TOKENS
        return value.coerceIn(SESSION_MIN_MAX_TOKENS, SESSION_MAX_MAX_TOKENS)
    }

    /**
     * Clamp a per-call ceiling into `[1, sessionMax]`. Non-positive or
     * missing values fall back to [callDefault]; anything above the
     * session ceiling is capped, never rejected (the session owns the
     * hard bound).
     */
    fun clampCallMaxTokens(requested: Int?, sessionMax: Int, callDefault: Int = 256): Int {
        val ceiling = sessionMax.coerceAtLeast(1)
        val value = if (requested == null || requested <= 0) callDefault else requested
        return value.coerceIn(1, ceiling)
    }

    fun isPromptAcceptable(prompt: String?): Boolean =
        !prompt.isNullOrBlank() && prompt.length <= MAX_PROMPT_CHARS

    fun isGenerationIdAcceptable(generationId: String?): Boolean =
        !generationId.isNullOrBlank() && generationId.length <= 128
}
