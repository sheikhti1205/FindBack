package com.findback.app.vlm

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Task 13 Step 1: redaction is load-bearing. Same semantics as the JS
 * pipeline (vlmParser.ts / vlmDiscovery.ts SENSITIVE_PATTERNS + token/secret
 * key denylist): secrets and PII-shaped values never survive, and model
 * outputs travel as length/hash/verdict only — never raw text.
 */
class DiagTest {

    @Test fun secretKeysNeverSurviveSanitization() {
        val fields = mapOf(
            "LLM_API_KEY" to "sk-abc123xyz",
            "apikey" to "whatever",
            "Authorization" to "Bearer eyJ9",
            "sb_publishable_key" to "sb_publishable_abc",
            "token" to "tok_123",
            "password" to "hunter2",
            "event" to "vlm.analyze.done"
        )
        val clean = Diag.sanitizeFields(fields)
        for (key in listOf("LLM_API_KEY", "apikey", "Authorization", "sb_publishable_key", "token", "password")) {
            assertEquals("[redacted]", clean[key], "key $key must be redacted")
        }
        assertEquals("vlm.analyze.done", clean["event"])
    }

    @Test fun secretShapedValuesAreRedacted() {
        assertEquals("[redacted]", Diag.redactSensitiveText("4111 1111 1111 1111"))
        assertEquals("[redacted]", Diag.redactSensitiveText("+880 1712-345678"))
        assertEquals("[redacted]", Diag.redactSensitiveText("owner@example.com"))
        assertEquals("[redacted]", Diag.redactSensitiveText("OTP 483921"))
        assertEquals("[redacted]", Diag.redactSensitiveText("https://evil.example/qr"))
        assertEquals("[redacted]", Diag.redactSensitiveText("sb_publishable_abcdef123"))
        assertEquals("[redacted]", Diag.redactSensitiveText("sk-abc123xyz789"))
    }

    @Test fun benignTextPassesThrough() {
        assertEquals("black wallet", Diag.redactSensitiveText("black wallet"))
    }

    @Test fun modelOutputTravelsAsDigestOnly() {
        val digest = Diag.outputDigest("hello world")
        assertEquals(11, digest["outputLength"])
        assertEquals(64, (digest["outputSha256"] as String).length)
        assertFalse(digest.values.any { it == "hello world" }, "raw model text must not be in the digest")

        val clean = Diag.sanitizeFields(
            mapOf(
                "text" to "hello world",
                "output" to "hello world",
                "rawText" to "hello world",
                "outputLength" to 11,
                "parseVerdict" to "ok"
            )
        )
        assertNull(clean["text"], "raw-text field must be dropped on the standard path")
        assertNull(clean["output"])
        assertNull(clean["rawText"])
        assertEquals(11, clean["outputLength"])
        assertEquals("ok", clean["parseVerdict"])
    }

    @Test fun boundedSampleRequiresExplicitDevFlag() {
        assertNull(Diag.boundedSample("hello world", allowDevSample = false))
        val sample = Diag.boundedSample("hello world", allowDevSample = true)
        assertTrue(sample != null && sample.length <= 200)
        assertEquals(
            "[redacted]",
            Diag.boundedSample("owner@example.com", allowDevSample = true),
            "dev sample must still pass through the redactor"
        )
    }

    @Test fun jsonlAppendCarriesEventAndTraceId() {
        val dir = createTempDir("diag-test")
        try {
            val file = Diag.appendEvent(
                dir = dir,
                event = "vlm.analyze.done",
                fields = mapOf("outputLength" to 11, "parseVerdict" to "ok"),
                traceId = "trace-123",
                mirrorLog = false
            )
            assertTrue(file.exists())
            val line = file.readLines().single()
            assertTrue(line.contains("\"vlm.analyze.done\""), line)
            assertTrue(line.contains("trace-123"), line)
            assertTrue(line.contains("outputLength"), line)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test fun rotationPrunesFilesOlderThanSevenDays() {
        val dir = createTempDir("diag-rotation")
        try {
            val now = System.currentTimeMillis()
            val old = File(dir, "diag-20000101.jsonl").apply {
                writeText("{}\n")
                setLastModified(now - 8L * 24 * 60 * 60 * 1000)
            }
            val fresh = File(dir, "diag-20990101.jsonl").apply {
                writeText("{}\n")
                setLastModified(now)
            }
            Diag.pruneOldFiles(dir, nowMs = now)
            assertFalse(old.exists(), "8-day-old diag file must be pruned")
            assertTrue(fresh.exists(), "fresh diag file must survive rotation")
        } finally {
            dir.deleteRecursively()
        }
    }

    private fun createTempDir(prefix: String): File {
        val dir = File(System.getProperty("java.io.tmpdir"), "$prefix-${System.nanoTime()}")
        dir.mkdirs()
        return dir
    }
}
