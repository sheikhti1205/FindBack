package com.findback.app.vlm

/**
 * Cancellation token + native-running guard for one serialized inference.
 *
 * The plugin holds the [InferenceMutex] from dispatch until the native
 * `analyze()` call returns. [cancel] only flips [Token.cancelled] so the
 * eventual result is ignored; it never clears the active token and never
 * releases the mutex early. [finishNative] runs in `finally` after the
 * native call returns: it clears the token (releasing the mutex path) and
 * reports whether an engine release was deferred while native code ran.
 * Delete/release paths check [isNativeRunning] and must reject BUSY or
 * defer the engine close — never close the engine underneath inference.
 */
class ActiveInferenceController {

    class Token internal constructor(val requestId: Long) {
        @Volatile var cancelled: Boolean = false
        @Volatile var nativeRunning: Boolean = false
    }

    private val lock = Any()
    private var active: Token? = null
    private var nextRequestId = 0L
    private var deferredEngineRelease = false

    /**
     * Begins an inference. Returns null when another inference is active.
     * The caller must hold the [InferenceMutex] before calling this.
     */
    fun begin(): Token? = synchronized(lock) {
        if (active != null) return null
        val token = Token(++nextRequestId)
        active = token
        token
    }

    /**
     * Marks the active inference cancelled. The eventual native result must
     * be ignored, but the token stays active (and the mutex stays held)
     * until [finishNative]. Returns the cancelled token, or null when idle.
     */
    fun cancel(): Token? = synchronized(lock) {
        val token = active ?: return null
        token.cancelled = true
        token
    }

    /**
     * Flags native execution state on the owning token. Stale tokens from a
     * previous inference are ignored.
     */
    fun markNativeRunning(token: Token, running: Boolean) = synchronized(lock) {
        if (active === token) {
            token.nativeRunning = running
        }
    }

    /**
     * Called in `finally` after the native `analyze()` returns. Clears the
     * token so the next inference may begin. Returns true when an engine
     * release was deferred while native code was running; the caller then
     * performs the release now that nothing runs underneath it.
     */
    fun finishNative(token: Token): Boolean = synchronized(lock) {
        if (active !== token) return false
        token.nativeRunning = false
        active = null
        val deferred = deferredEngineRelease
        deferredEngineRelease = false
        deferred
    }

    fun isActive(): Boolean = synchronized(lock) { active != null }

    fun isNativeRunning(): Boolean = synchronized(lock) { active?.nativeRunning == true }

    fun isCancelled(token: Token): Boolean = synchronized(lock) {
        if (active !== token) return true
        token.cancelled
    }

    /**
     * Defers an engine close requested while native code runs. Returns false
     * when nothing is running (caller should release immediately instead).
     */
    fun deferEngineRelease(): Boolean = synchronized(lock) {
        if (active?.nativeRunning == true) {
            deferredEngineRelease = true
            true
        } else {
            false
        }
    }
}
