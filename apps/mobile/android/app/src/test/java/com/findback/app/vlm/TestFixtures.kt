package com.findback.app.vlm

import java.security.MessageDigest

/**
 * Test-only hashing fixture. Real chunk hashes are generated from the pinned
 * immutable model source (never invented for real weights); tests use these
 * fixtures for small synthetic byte ranges.
 */
object TestHashes {
    fun sha256Of(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

/**
 * Test-only manual clock for lease tests.
 */
class FakeClock(var nowMs: Long) : WarmEngineLease.Clock {
    override fun nowMs(): Long = nowMs
    fun advance(ms: Long) { nowMs += ms }
}
