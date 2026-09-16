package com.findback.app.vlm

/**
 * A simple mutex to serialize VLM inference calls.
 * Only one inference can run at a time.
 */
class InferenceMutex {
    private val lock = Any()
    private var held = false

    /**
     * Attempts to acquire the mutex.
     * @return true if acquired, false if already held.
     */
    fun tryAcquire(): Boolean = synchronized(lock) {
        if (held) false else { held = true; true }
    }

    /**
     * Releases the mutex.
     */
    fun release() = synchronized(lock) {
        held = false
    }

    /**
     * Checks if the mutex is currently held.
     * @return true if held, false otherwise.
     */
    fun isHeld(): Boolean = synchronized(lock) {
        held
    }
}
