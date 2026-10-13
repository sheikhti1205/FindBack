package com.findback.app.map

import java.security.MessageDigest

/**
 * Pure validation + normalization for the keyless MapLibre map layer.
 *
 * Everything here is JVM-testable (no Android runtime, no network): the
 * Activity and plugin are thin shells over these rules. Style URL semantics:
 * the URL is NON-SECRET provider config — validated once (HTTPS, non-empty,
 * non-placeholder) and replaceable without code changes.
 */
object MapValidation {
    const val MIN_LATITUDE = -90.0
    const val MAX_LATITUDE = 90.0
    const val MIN_LONGITUDE = -180.0
    const val MAX_LONGITUDE = 180.0

    /** Renderer-supported zoom range for picker, viewer, and snapshots. */
    const val MIN_ZOOM = 1.0
    const val MAX_ZOOM = 20.0
    const val DEFAULT_ZOOM = 15.0

    /** Owner-decided default style (OpenFreeMap Liberty, OSM-derived data). */
    const val DEFAULT_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty"

    /** Style provider seam for the public Nominatim search endpoint. */
    const val DEFAULT_NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search"

    /** Attribution line for surfaces the SDK does not annotate itself. */
    const val MAP_ATTRIBUTION = "© OpenStreetMap contributors"

    /** Snapshot output caps (doc: max 1024 px per side) to avoid memory abuse. */
    const val MIN_SNAPSHOT_EDGE_PX = 64
    const val MAX_SNAPSHOT_EDGE_PX = 1024

    /** Bounded snapshot cache (LRU-by-mtime eviction in the service). */
    const val MAX_SNAPSHOT_CACHE_BYTES = 24L * 1024 * 1024

    fun isValidLatitude(lat: Double?): Boolean =
        lat != null && lat.isFinite() && lat >= MIN_LATITUDE && lat <= MAX_LATITUDE

    fun isValidLongitude(lng: Double?): Boolean =
        lng != null && lng.isFinite() && lng >= MIN_LONGITUDE && lng <= MAX_LONGITUDE

    fun isValidCenter(lat: Double?, lng: Double?): Boolean =
        isValidLatitude(lat) && isValidLongitude(lng)

    /** Clamp to the renderer range; non-finite/missing input takes [default]. */
    fun clampZoom(zoom: Double?, default: Double = DEFAULT_ZOOM): Double {
        if (zoom == null || !zoom.isFinite()) return default
        return zoom.coerceIn(MIN_ZOOM, MAX_ZOOM)
    }

    /**
     * Validate an effective style URL. Returns the trimmed URL when it is a
     * usable HTTPS endpoint, else [fallback] (never blank). Rejects reserved
     * documentation hosts (RFC 2606) and obvious placeholder text so a
     * misconfigured build degrades to the default instead of a dead map.
     */
    fun validateStyleUrl(raw: String?, fallback: String = DEFAULT_STYLE_URL): String {
        val url = raw?.trim().orEmpty()
        if (url.isEmpty() || url.contains(' ') || url.contains('<') || url.contains('>')) return fallback
        val lower = url.lowercase()
        if (!lower.startsWith("https://")) return fallback
        if (lower.contains("placeholder") || lower.contains("changeme") || lower.contains("your-") || lower.contains("your_")) return fallback
        val host = lower.removePrefix("https://").substringBefore('/').substringBefore(':')
        if (host.isEmpty()) return fallback
        if (host == "example.com" || host == "example.org" || host == "example.net" ||
            host.endsWith(".example.com") || host.endsWith(".example.org") || host.endsWith(".example.net")
        ) return fallback
        return url
    }

    fun clampSnapshotEdge(px: Int): Int = px.coerceIn(MIN_SNAPSHOT_EDGE_PX, MAX_SNAPSHOT_EDGE_PX)

    /**
     * Renderer-neutral style provider for diagnostics: "openfreemap" only
     * when the effective style URL is the owner-decided default, "custom"
     * otherwise. Never carries a URL or secret.
     */
    fun styleProvider(effectiveStyleUrl: String): String =
        if (effectiveStyleUrl.trim() == DEFAULT_STYLE_URL) "openfreemap" else "custom"

    /**
     * Validate an effective Nominatim `/search` endpoint. Returns the trimmed
     * URL when it is a usable HTTPS endpoint, else [fallback] (never blank).
     * Mirrors [validateStyleUrl] so a misconfigured build degrades to the
     * default instead of a dead search.
     */
    fun validateSearchEndpoint(raw: String?, fallback: String = DEFAULT_NOMINATIM_ENDPOINT): String {
        val url = raw?.trim().orEmpty()
        if (url.isEmpty() || url.contains(' ') || url.contains('<') || url.contains('>')) return fallback
        val lower = url.lowercase()
        if (!lower.startsWith("https://")) return fallback
        if (lower.contains("placeholder") || lower.contains("changeme") || lower.contains("your-") || lower.contains("your_")) return fallback
        val host = lower.removePrefix("https://").substringBefore('/').substringBefore(':')
        if (host.isEmpty()) return fallback
        return url
    }

    /**
     * Lifecycle guard for async search delivery (JVM-testable): a response
     * may touch UI only when its generation still matches the current one
     * and the Activity is neither destroyed nor finishing. Anything else
     * dies silently.
     */
    fun isSearchDeliveryAlive(
        requestGeneration: Int,
        currentGeneration: Int,
        destroyed: Boolean,
        finishing: Boolean,
    ): Boolean = requestGeneration == currentGeneration && !destroyed && !finishing

    /**
     * Stable cache key for a snapshot request. Coordinates are rounded to 5
     * decimals for KEY precision only — the stored report value is never
     * rounded here. Any scope input (style, geometry, size, theme) changes
     * the key. SHA-256 hex, filesystem-safe.
     */
    fun snapshotCacheKey(
        lat: Double,
        lng: Double,
        zoom: Double,
        widthPx: Int,
        heightPx: Int,
        theme: String,
        styleUrl: String,
    ): String {
        val canonical = buildString {
            append("v1|")
            append(styleUrl.trim()).append('|')
            append("%.5f".format(java.util.Locale.US, lat)).append(',')
            append("%.5f".format(java.util.Locale.US, lng)).append('|')
            append("%.2f".format(java.util.Locale.US, zoom)).append('|')
            append(widthPx).append('x').append(heightPx).append('|')
            append(theme.trim().lowercase())
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
