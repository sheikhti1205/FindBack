package com.findback.app.vlm

import org.junit.Assert.*
import org.junit.Test

class RuntimeOperationGateTest {
    @Test fun timingOwnsRuntimeUntilItsLeaseCloses() {
        val gate = RuntimeOperationGate()
        val timing = gate.acquire()!!
        assertNull(gate.acquire()) // load, generation and unload cannot overlap the probe
        timing.close()
        val generation = gate.acquire()!!
        timing.close() // stale cleanup must not release the new owner
        assertNull(gate.acquire())
        generation.close()
        assertNotNull(gate.acquire())
    }
}
