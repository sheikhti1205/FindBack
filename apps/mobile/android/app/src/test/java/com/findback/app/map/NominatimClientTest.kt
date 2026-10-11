package com.findback.app.map

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Pure-JVM tests for [NominatimClient] parsing/throttling plus the
 * [NominatimGate] ≤1 req/s floor. No network — HTTP transport errors are
 * covered by kind mapping on-device; parsing is fully deterministic here.
 */
class NominatimClientTest {

    private val payload = """
        [
          {"display_name": "Chattogram, Bangladesh", "lat": "22.3569", "lon": "91.7832"},
          {"display_name": "  ", "lat": "22.0", "lon": "91.0"},
          {"display_name": "No coords", "lat": "NaN", "lon": "91.0"},
          {"display_name": "Out of range", "lat": "95.0", "lon": "91.0"},
          {"display_name": "University of Chittagong", "lat": 22.4716, "lon": 91.7877},
          {"lat": "22.0", "lon": "91.0"}
        ]
    """.trimIndent()

    @Test fun parsesAndSanitizesResults() {
        val results = NominatimClient.parseResults(payload)
        assertEquals(2, results.size)
        assertEquals("Chattogram, Bangladesh", results[0].displayName)
        assertEquals(22.3569, results[0].latitude)
        assertEquals(91.7832, results[0].longitude)
        assertEquals("University of Chittagong", results[1].displayName)
    }

    @Test fun capsResultsAtLimit() {
        val results = NominatimClient.parseResults(payload, limit = 1)
        assertEquals(1, results.size)
    }

    @Test fun rejectsNonArrayAndBlankBodies() {
        assertTrue(NominatimClient.parseResults("").isEmpty())
        assertTrue(NominatimClient.parseResults("   ").isEmpty())
        assertTrue(NominatimClient.parseResults("""{"a":1}""").isEmpty())
        assertFailsWith<NominatimException> {
            NominatimClient.parseResults("not json [[[")
        }
    }

    @Test fun buildsExplicitSearchUrl() {
        val url = NominatimClient.buildSearchUrl(
            "https://nominatim.openstreetmap.org/search",
            "University of Chittagong",
            limit = 5,
        )
        assertEquals(
            "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=University%20of%20Chittagong",
            url,
        )
    }

    @Test fun throttlerEnforcesOneRequestPerSecond() {
        val gate = NominatimGate(minIntervalMs = 1100L)
        assertEquals(0L, gate.retryAfterMs(10_000L))
        assertEquals(1100L, gate.retryAfterMs(10_000L))
        assertEquals(100L, gate.retryAfterMs(11_000L))
        assertEquals(0L, gate.retryAfterMs(11_100L))
    }

    @Test fun blankQueryIsRejectedBeforeNetwork() {
        assertFailsWith<NominatimException> {
            NominatimClient.fetchResults(
                endpoint = "https://nominatim.openstreetmap.org/search",
                query = "   ",
                userAgent = "FindBack/1.0.0 (Android)",
            )
        }
    }
}
