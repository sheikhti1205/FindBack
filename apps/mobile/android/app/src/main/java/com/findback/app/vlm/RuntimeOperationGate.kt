package com.findback.app.vlm

import java.util.concurrent.atomic.AtomicBoolean

/** One owner across engine initialization, measurement, generation and release. */
class RuntimeOperationGate {
    private val busy = AtomicBoolean(false)

    fun acquire(): AutoCloseable? {
        if (!busy.compareAndSet(false, true)) return null
        val closed = AtomicBoolean(false)
        return AutoCloseable {
            if (closed.compareAndSet(false, true)) busy.set(false)
        }
    }
}
