package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class InferenceMutexTest {
    @Test fun serializesConcurrentInference() {
        val mutex = InferenceMutex()
        assertTrue(mutex.tryAcquire())
        assertFalse(mutex.tryAcquire())
        mutex.release()
        assertTrue(mutex.tryAcquire())
        mutex.release()
    }
}