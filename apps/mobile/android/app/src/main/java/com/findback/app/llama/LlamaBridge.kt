package com.findback.app.llama

/**
 * Thin JNI surface over `findback_llama` (pinned llama.cpp v0.5.0,
 * CPU-only lab target). All calls serialize on the plugin-side lock in
 * [FindbackLlama] — the bridge owns one process-global session.
 * Throws [NativeLlamaException] on lab failures.
 */
internal object LlamaBridge {
    private var loaded = false

    fun ensureLoaded(): Boolean {
        if (loaded) return true
        return try {
            System.loadLibrary("findback_llama")
            loaded = true
            true
        } catch (_: UnsatisfiedLinkError) {
            false
        } catch (_: SecurityException) {
            false
        }
    }

    external fun nativeInit()
    external fun nativeLoad(modelPath: String, nCtx: Int, nThreads: Int)
    external fun nativeBegin(prompt: String): Int
    external fun nativeNext(): String?
    external fun nativeCancel()
    external fun nativeSystemInfo(): String
    external fun nativeUnload()
}
