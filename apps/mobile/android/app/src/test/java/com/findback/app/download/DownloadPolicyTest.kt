package com.findback.app.download

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure-JVM tests for [DownloadPolicy]: https gate, redirect resolution,
 * Content-Range parsing, and v1 journal JSON shape. No network, no
 * storage — the plugin loop is covered on-device.
 */
class DownloadPolicyTest {

    @Test fun httpsGate() {
        assertTrue(DownloadPolicy.isHttps("https://cdn.example.com/m.gguf"))
        assertFalse(DownloadPolicy.isHttps("http://cdn.example.com/m.gguf"))
        assertFalse(DownloadPolicy.isHttps("not a url"))
        assertFalse(DownloadPolicy.isHttps(""))
    }

    @Test fun redirectResolution() {
        assertEquals(
            "https://cdn.example.com/b",
            DownloadPolicy.resolveRedirect("https://cdn.example.com/a", "/b"),
        )
        assertEquals(
            "https://other.example.com/b",
            DownloadPolicy.resolveRedirect("https://cdn.example.com/a", "https://other.example.com/b"),
        )
        assertNull(
            DownloadPolicy.resolveRedirect("https://cdn.example.com/a", "http://cdn.example.com/b"),
        )
    }

    @Test fun contentRangeTotal() {
        assertEquals(
            100L,
            DownloadPolicy.parseTotalFromContentRange("bytes 10-49/100", 10L),
        )
        assertNull(DownloadPolicy.parseTotalFromContentRange("bytes 11-49/100", 10L))
        assertNull(DownloadPolicy.parseTotalFromContentRange("bytes 10-49/*", 10L))
        assertNull(DownloadPolicy.parseTotalFromContentRange("garbage", 10L))
        assertNull(DownloadPolicy.parseTotalFromContentRange(null, 10L))
    }

    @Test fun journalJsonMatchesTsV1Shape() {
        val json = DownloadPolicy.journalJson(
            modelId = "smolvlm2-500m-vision",
            revision = "dad030b6",
            filePath = "model.litertlm",
            url = "https://cdn.example.com/m",
            offset = 42L,
            total = 100L,
            sha = "ab12",
            updatedAtIso = "2026-10-03T00:00:00.000Z",
        )
        assertTrue(json.contains("\"v\":1"))
        assertTrue(json.contains("\"modelId\":\"smolvlm2-500m-vision\""))
        assertTrue(json.contains("\"offset\":42"))
        assertTrue(json.contains("\"total\":100"))
        // org.json is on the unit-test classpath: the journal must parse
        // back with the exact v1 keys TS `readJournal` requires.
        val parsed = org.json.JSONObject(json)
        assertEquals(1, parsed.getInt("v"))
        assertEquals("https://cdn.example.com/m", parsed.getString("url"))
        assertEquals("2026-10-03T00:00:00.000Z", parsed.getString("updatedAt"))
    }

    @Test fun journalJsonNullTotal() {
        val json = DownloadPolicy.journalJson("m", "r", "f", "https://x.example/y", 0L, null, "", "t")
        assertTrue(json.contains("\"total\":null"))
    }
}
