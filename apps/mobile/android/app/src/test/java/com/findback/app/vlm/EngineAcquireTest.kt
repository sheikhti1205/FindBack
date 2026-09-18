package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * WP1 (audit #1): acquiring the 500M engine must yield a genuinely
 * initialized engine, or null with the failed construction closed.
 * A constructed-but-uninitialized engine made analyze() throw
 * "Engine not initialized" after restart / warm-lease expiry.
 */
class EngineAcquireTest {

    private class FakeEngine {
        var initializeCalls = 0
        var releaseCalls = 0
        var failOnInitialize: RuntimeException? = null
        var failOnRelease: RuntimeException? = null

        fun initialize() {
            initializeCalls++
            failOnInitialize?.let { throw it }
        }

        fun release() {
            releaseCalls++
            failOnRelease?.let { throw it }
        }
    }

    @Test
    fun acquire_returnsInitializedEngine_onSuccess() {
        val fake = FakeEngine()

        val result = acquireInitializedEngine(
            create = { fake },
            initialize = { it.initialize() },
            close = { it.release() }
        )

        assertSame(fake, result)
        assertEquals(1, fake.initializeCalls)
        assertEquals(0, fake.releaseCalls)
    }

    @Test
    fun acquire_closesAndReturnsNull_whenInitializeFails() {
        val fake = FakeEngine()
        fake.failOnInitialize = RuntimeException("GPU backend unavailable")

        val result = acquireInitializedEngine(
            create = { fake },
            initialize = { it.initialize() },
            close = { it.release() }
        )

        assertNull(result)
        assertEquals(1, fake.initializeCalls)
        assertEquals(1, fake.releaseCalls, "failed construction must be closed, never stored")
    }

    @Test
    fun acquire_stillReturnsNull_whenCloseAlsoThrows() {
        val fake = FakeEngine()
        fake.failOnInitialize = RuntimeException("GPU backend unavailable")
        fake.failOnRelease = RuntimeException("close failed")

        val result = acquireInitializedEngine(
            create = { fake },
            initialize = { it.initialize() },
            close = { it.release() }
        )

        assertNull(result)
        assertTrue(fake.releaseCalls == 1, "close must be attempted even if it throws")
    }
}
