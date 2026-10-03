package com.findback.app.needle

/**
 * Thin JNI surface over `findback_needle`. All calls serialize on the
 * plugin-side lock in [FindbackNeedle] — the engine is process-global and
 * non-thread-safe. Throws [NativeNeedleException] on engine failures.
 */
internal object NeedleBridge {
    private var loaded = false

    fun ensureLoaded(): Boolean {
        if (loaded) return true
        return try {
            System.loadLibrary("findback_needle")
            loaded = true
            true
        } catch (_: UnsatisfiedLinkError) {
            false
        } catch (_: SecurityException) {
            false
        }
    }

    external fun nativeLoad(modelPath: String)
    external fun nativeModels(): Int
    external fun nativeEmbedDim(): Int
    external fun nativeEmbed(text: String, dim: Int): FloatArray
    external fun nativeComplete(input: String, maxNewTokens: Int): String
    external fun nativeInitTools(systemPrompt: String?, toolsJson: String?)
    external fun nativeReset()
    external fun nativeUnload()
}
