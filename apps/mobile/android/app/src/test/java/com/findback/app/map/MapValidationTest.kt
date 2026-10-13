package com.findback.app.map

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure-JVM tests for [MapValidation]: coordinate validation, zoom clamping,
 * style-URL validation, snapshot dimension caps, and cache-key generation.
 * No Android runtime, no network — the Activity/plugin loop is covered
 * on-device (MAP-11).
 */
class MapValidationTest {

    @Test fun coordinateValidation() {
        assertTrue(MapValidation.isValidCenter(23.8103, 90.4125))
        assertTrue(MapValidation.isValidCenter(-90.0, -180.0))
        assertTrue(MapValidation.isValidCenter(90.0, 180.0))
        assertFalse(MapValidation.isValidCenter(90.0001, 0.0))
        assertFalse(MapValidation.isValidCenter(0.0, 180.0001))
        assertFalse(MapValidation.isValidCenter(Double.NaN, 0.0))
        assertFalse(MapValidation.isValidCenter(0.0, Double.POSITIVE_INFINITY))
        assertFalse(MapValidation.isValidCenter(null, 0.0))
        assertFalse(MapValidation.isValidCenter(0.0, null))
    }

    @Test fun zoomClamp() {
        assertEquals(15.0, MapValidation.clampZoom(15.0))
        assertEquals(MapValidation.MAX_ZOOM, MapValidation.clampZoom(99.0))
        assertEquals(MapValidation.MIN_ZOOM, MapValidation.clampZoom(-3.0))
        assertEquals(MapValidation.DEFAULT_ZOOM, MapValidation.clampZoom(Double.NaN))
        assertEquals(MapValidation.DEFAULT_ZOOM, MapValidation.clampZoom(null))
        assertEquals(10.0, MapValidation.clampZoom(null, 10.0))
    }

    @Test fun styleUrlValidation() {
        val openFreeMap = "https://tiles.openfreemap.org/styles/liberty"
        assertEquals(openFreeMap, MapValidation.validateStyleUrl(openFreeMap))
        assertEquals(openFreeMap, MapValidation.validateStyleUrl("  $openFreeMap  "))
        // Anything unusable falls back to the default — never an empty URL.
        assertEquals(openFreeMap, MapValidation.validateStyleUrl(null))
        assertEquals(openFreeMap, MapValidation.validateStyleUrl(""))
        assertEquals(openFreeMap, MapValidation.validateStyleUrl("http://tiles.openfreemap.org/styles/liberty"))
        assertEquals(openFreeMap, MapValidation.validateStyleUrl("https://example.com/style.json"))
        assertEquals(openFreeMap, MapValidation.validateStyleUrl("https://tiles.openfreemap.org/styles/YOUR_STYLE"))
        assertEquals(openFreeMap, MapValidation.validateStyleUrl("not a url"))
        // A documented self-hosted override passes through untouched.
        val custom = "https://tiles.maps.internal/styles/basic"
        assertEquals(custom, MapValidation.validateStyleUrl(custom))
    }

    @Test fun styleProviderIsRendererNeutral() {
        // The default OpenFreeMap style reports "openfreemap"; anything else
        // is "custom" (never a URL or secret in diagnostics).
        assertEquals("openfreemap", MapValidation.styleProvider(MapValidation.DEFAULT_STYLE_URL))
        assertEquals("openfreemap", MapValidation.styleProvider("  ${MapValidation.DEFAULT_STYLE_URL}  "))
        assertEquals("custom", MapValidation.styleProvider("https://tiles.maps.internal/styles/basic"))
        assertEquals("custom", MapValidation.styleProvider(""))
    }

    @Test fun searchEndpointValidation() {
        val default = MapValidation.DEFAULT_NOMINATIM_ENDPOINT
        assertEquals(default, MapValidation.validateSearchEndpoint(default))
        assertEquals(default, MapValidation.validateSearchEndpoint("  $default  "))
        assertEquals(default, MapValidation.validateSearchEndpoint(null))
        assertEquals(default, MapValidation.validateSearchEndpoint(""))
        assertEquals(default, MapValidation.validateSearchEndpoint("http://nominatim.openstreetmap.org/search"))
        assertEquals(default, MapValidation.validateSearchEndpoint("not a url"))
        val custom = "https://proxy.internal/nominatim/search"
        assertEquals(custom, MapValidation.validateSearchEndpoint(custom))
    }

    @Test fun searchDeliveryDiesOnStaleOrDestroyed() {
        assertTrue(MapValidation.isSearchDeliveryAlive(3, 3, destroyed = false, finishing = false))
        // A newer search started: the stale response must die silently.
        assertFalse(MapValidation.isSearchDeliveryAlive(2, 3, destroyed = false, finishing = false))
        // A destroyed/finishing Activity must never touch UI.
        assertFalse(MapValidation.isSearchDeliveryAlive(3, 3, destroyed = true, finishing = false))
        assertFalse(MapValidation.isSearchDeliveryAlive(3, 3, destroyed = false, finishing = true))
        assertFalse(MapValidation.isSearchDeliveryAlive(3, 3, destroyed = true, finishing = true))
    }

    @Test fun snapshotDimensionCaps() {
        assertEquals(512, MapValidation.clampSnapshotEdge(512))
        assertEquals(MapValidation.MAX_SNAPSHOT_EDGE_PX, MapValidation.clampSnapshotEdge(4096))
        assertEquals(MapValidation.MIN_SNAPSHOT_EDGE_PX, MapValidation.clampSnapshotEdge(0))
        assertEquals(MapValidation.MIN_SNAPSHOT_EDGE_PX, MapValidation.clampSnapshotEdge(-8))
    }

    @Test fun snapshotCacheKeyIsStableAndScoped() {
        val a = MapValidation.snapshotCacheKey(23.8103, 90.4125, 15.0, 512, 320, "light", "https://s/style.json")
        val b = MapValidation.snapshotCacheKey(23.8103, 90.4125, 15.0, 512, 320, "light", "https://s/style.json")
        assertEquals(a, b)
        assertEquals(64, a.length)
        // Cache precision (5 decimals) must not leak into the report value —
        // sub-meter jitter maps to the same key.
        val jitter = MapValidation.snapshotCacheKey(23.8103004, 90.4124996, 15.0, 512, 320, "light", "https://s/style.json")
        assertEquals(a, jitter)
        // Any scope input changes the key.
        val variants = setOf(
            MapValidation.snapshotCacheKey(23.82, 90.4125, 15.0, 512, 320, "light", "https://s/style.json"),
            MapValidation.snapshotCacheKey(23.8103, 90.4125, 14.0, 512, 320, "light", "https://s/style.json"),
            MapValidation.snapshotCacheKey(23.8103, 90.4125, 15.0, 256, 320, "light", "https://s/style.json"),
            MapValidation.snapshotCacheKey(23.8103, 90.4125, 15.0, 512, 320, "dark", "https://s/style.json"),
            MapValidation.snapshotCacheKey(23.8103, 90.4125, 15.0, 512, 320, "light", "https://s/other.json"),
        )
        assertFalse(variants.contains(a))
        assertEquals(5, variants.size)
    }
}
