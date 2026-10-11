package com.findback.app.map

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** One sanitized Nominatim `/search` result (display name + coordinates). */
data class NominatimResult(
    val displayName: String,
    val latitude: Double,
    val longitude: Double,
)

/** Failure taxonomy for explicit-submit search — mapped to consumer copy by callers. */
class NominatimException(val kind: Kind, message: String) : Exception(message) {
    enum class Kind { RATE_LIMITED, NETWORK, SERVER, INVALID }
}

/**
 * Enforces the public-Nominatim ≤1 request/second floor with an injectable
 * clock (testable). Returns 0 when the request may proceed, else the
 * milliseconds to wait. Thread-safe: the Activity fires from the UI thread
 * while retries may come from anywhere.
 */
class NominatimGate(private val minIntervalMs: Long = 1100L) {
    private var lastRequestAt: Long? = null

    @Synchronized
    fun retryAfterMs(nowMs: Long): Long {
        val last = lastRequestAt
        if (last != null && nowMs - last < minIntervalMs) {
            return minIntervalMs - (nowMs - last)
        }
        lastRequestAt = nowMs
        return 0L
    }
}

/**
 * Minimal native Nominatim client for the map picker (explicit submit only —
 * no keystroke autocomplete path exists anywhere in this class).
 *
 * Privacy/discipline: no query, result, or coordinate is ever logged; the
 * request carries an app-specific User-Agent per usage policy; HTTPS only.
 */
object NominatimClient {
    const val DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org/search"
    const val MAX_RESULTS = 5
    const val TIMEOUT_MS = 12_000
    const val MAX_BODY_BYTES = 256 * 1024

    fun buildSearchUrl(endpoint: String, query: String, limit: Int = MAX_RESULTS): String {
        val base = endpoint.trim().trimEnd('/')
        // Match the web path's encodeURIComponent form (%20, not form-style +).
        val encoded = URLEncoder.encode(query.trim(), "UTF-8").replace("+", "%20")
        return "$base?format=jsonv2&limit=$limit&q=$encoded"
    }

    /**
     * Parse a `/search` JSON body into sanitized results (max [limit]).
     * Malformed entries are skipped; a non-array/blank body yields an empty
     * list; unparseable JSON throws [NominatimException] (INVALID).
     */
    fun parseResults(body: String, limit: Int = MAX_RESULTS): List<NominatimResult> {
        if (body.isBlank()) return emptyList()
        val array: JSONArray = try {
            JSONArray(body)
        } catch (e: Exception) {
            // A JSON object (or other scalar) carries no result list — empty,
            // not an error. Anything else unparseable is INVALID.
            try {
                JSONObject(body)
                return emptyList()
            } catch (e2: Exception) {
                throw NominatimException(NominatimException.Kind.INVALID, "Place search returned an unreadable response.")
            }
        }
        val out = ArrayList<NominatimResult>(minOf(limit, array.length()))
        for (i in 0 until array.length()) {
            if (out.size >= limit) break
            val item = array.optJSONObject(i) ?: continue
            val name = item.optString("display_name", "").trim()
            if (name.isEmpty()) continue
            val lat = item.opt("lat")?.toString()?.toDoubleOrNull()
            val lng = item.opt("lon")?.toString()?.toDoubleOrNull()
            if (!MapValidation.isValidCenter(lat, lng)) continue
            out.add(NominatimResult(name, lat!!, lng!!))
        }
        return out
    }

    /**
     * Run ONE explicit user-triggered search synchronously (call off the UI
     * thread). Throws [NominatimException] — never returns null, never logs.
     */
    @Throws(NominatimException::class)
    fun fetchResults(
        endpoint: String,
        query: String,
        userAgent: String,
        timeoutMs: Int = TIMEOUT_MS,
        limit: Int = MAX_RESULTS,
    ): List<NominatimResult> {
        val trimmed = query.trim()
        if (trimmed.isEmpty()) {
            throw NominatimException(NominatimException.Kind.INVALID, "Type a place name first.")
        }
        val url = try {
            URL(buildSearchUrl(endpoint.ifBlank { DEFAULT_ENDPOINT }, trimmed, limit))
        } catch (e: Exception) {
            throw NominatimException(NominatimException.Kind.INVALID, "Place search is misconfigured.")
        }
        if (url.protocol != "https") {
            throw NominatimException(NominatimException.Kind.INVALID, "Place search is misconfigured.")
        }
        val connection: HttpURLConnection = try {
            (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                setRequestProperty("Accept", "application/json")
                setRequestProperty("User-Agent", userAgent.ifBlank { "FindBack (Android)" })
                instanceFollowRedirects = true
            }
        } catch (e: Exception) {
            throw NominatimException(NominatimException.Kind.NETWORK, "Place search could not connect.")
        }
        try {
            val code = try {
                connection.responseCode
            } catch (e: Exception) {
                throw NominatimException(NominatimException.Kind.NETWORK, "Place search could not connect.")
            }
            if (code != HttpURLConnection.HTTP_OK) {
                throw NominatimException(NominatimException.Kind.SERVER, "Place search failed — pan the map and confirm the pin instead.")
            }
            val body = try {
                connection.inputStream.use { stream ->
                    val out = ByteArrayOutputStream()
                    val buf = ByteArray(8192)
                    var total = 0
                    while (true) {
                        val read = stream.read(buf)
                        if (read < 0) break
                        total += read
                        if (total > MAX_BODY_BYTES) break
                        out.write(buf, 0, read)
                    }
                    out.toString("UTF-8")
                }
            } catch (e: Exception) {
                throw NominatimException(NominatimException.Kind.NETWORK, "Place search could not connect.")
            }
            return parseResults(body, limit)
        } finally {
            connection.disconnect()
        }
    }
}
