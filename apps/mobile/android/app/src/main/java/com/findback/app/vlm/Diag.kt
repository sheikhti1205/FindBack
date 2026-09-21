package com.findback.app.vlm

import android.util.Log
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Task 13 structured diagnostic sink (native side, authoritative storage).
 *
 * Appends redacted JSONL to `cacheDir/diag/` (7-day rotation) with an
 * optional `Log.i("FindBackDiag")` logcat mirror. Redaction is load-bearing
 * and mirrors the JS pipeline semantics: secrets and PII-shaped values never
 * survive, and model outputs travel as length/hash/verdict only — never raw
 * text. A redacted bounded sample (<=200 chars, explicit dev flag only) is
 * permitted for parser debugging, never the default.
 *
 * Automatic call-site hooks stay behind [enabled] (default off) so shipping
 * behavior is unchanged until the Settings toggle wires it. Explicit
 * [appendEvent] calls always write: an explicit call is explicit intent.
 */
object Diag {
    const val TAG = "FindBackDiag"
    const val REDACTED = "[redacted]"
    const val MAX_DEV_SAMPLE_CHARS = 200
    const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
    const val MAX_BRIDGE_JSON_CHARS = 8 * 1024

    @Volatile var enabled: Boolean = false

    fun setVerboseLogging(verbose: Boolean) {
        enabled = verbose
    }

    private val deniedKeyParts = listOf(
        "apikey", "api_key", "authorization", "sb_publishable", "sb_secret",
        "password", "passwd", "secret", "accesstoken", "refreshtoken", "idtoken"
    )
    private val deniedWholeKeys = setOf("token", "auth")
    private val deniedKeySuffixes = listOf("token", "secret")

    private val rawTextKeys = setOf("text", "output", "rawtext")

    private val sensitivePatterns = listOf(
        Regex("""\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b"""),
        Regex("""\+?\d[\d\s\-.()]{5,}\d"""),
        Regex("""\b[\w.+-]+@[\w-]+\.[\w.]+\b"""),
        Regex("""(?i)\b(?:otp|one-?time(?:-?password)?|verification|pin|passcode)\b[\s:#-]*\d{3,8}\b"""),
        Regex("""(?i)\bhttps?://\S+"""),
        Regex("""(?i)\bsb_publishable_[\w-]+\b"""),
        Regex("""\bsk-[\w-]{4,}\b"""),
        Regex("""(?i)\bsk_(live|test)_[\w-]+\b"""),
        Regex("""(?i)\bbearer\s+[\w.\-~+/]+=*""")
    )

    fun redactSensitiveText(text: String): String {
        return if (sensitivePatterns.any { it.containsMatchIn(text) }) REDACTED else text
    }

    fun sanitizeFields(fields: Map<String, Any?>): Map<String, Any?> {
        val clean = LinkedHashMap<String, Any?>(fields.size)
        for ((key, value) in fields) {
            val lower = key.lowercase(Locale.US)
            if (rawTextKeys.contains(lower)) continue
            if (deniedWholeKeys.contains(lower) ||
                deniedKeySuffixes.any { lower.endsWith(it) } ||
                deniedKeyParts.any { lower.contains(it) }
            ) {
                clean[key] = REDACTED
                continue
            }
            clean[key] = if (value is String) redactSensitiveText(value) else value
        }
        return clean
    }

    fun outputDigest(output: String): Map<String, Any> {
        return mapOf(
            "outputLength" to output.length,
            "outputSha256" to sha256Hex(output)
        )
    }

    fun boundedSample(output: String, allowDevSample: Boolean): String? {
        if (!allowDevSample) return null
        if (sensitivePatterns.any { it.containsMatchIn(output) }) return REDACTED
        return output.take(MAX_DEV_SAMPLE_CHARS)
    }

    fun appendEvent(
        dir: File,
        event: String,
        fields: Map<String, Any?>,
        traceId: String,
        mirrorLog: Boolean = true
    ): File {
        val nowMs = System.currentTimeMillis()
        dir.mkdirs()
        val file = fileFor(dir, nowMs)
        val line = buildLine(nowMs, event, traceId, sanitizeFields(fields))
        file.appendText(line + "\n")
        pruneOldFiles(dir, nowMs)
        if (mirrorLog) {
            try {
                Log.i(TAG, line)
            } catch (_: Exception) {
            }
        }
        return file
    }

    fun pruneOldFiles(dir: File, nowMs: Long = System.currentTimeMillis()) {
        val files = try {
            dir.listFiles { f -> f.isFile && f.name.startsWith("diag-") && f.name.endsWith(".jsonl") }
        } catch (_: Exception) {
            null
        } ?: return
        for (file in files) {
            try {
                if (nowMs - file.lastModified() > RETENTION_MS) file.delete()
            } catch (_: Exception) {
            }
        }
    }

    /**
     * Automatic hook entry point. No-op unless [enabled]; never throws, so a
     * diagnostics failure can never change app behavior. traceId travels
     * verbatim (random UUID, not content) and is never pattern-scanned.
     */
    fun event(cacheDir: File?, event: String, traceId: String?, fields: Map<String, Any?> = emptyMap()) {
        if (!enabled || cacheDir == null) return
        try {
            appendEvent(File(cacheDir, "diag"), event, fields, traceId ?: "", mirrorLog = true)
        } catch (_: Exception) {
        }
    }

    internal fun fileFor(dir: File, nowMs: Long): File {
        val day = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date(nowMs))
        return File(dir, "diag-$day.jsonl")
    }

    internal fun buildLine(nowMs: Long, event: String, traceId: String, fields: Map<String, Any?>): String {
        return "{\"ts\":$nowMs,\"event\":${valueToJson(event)}," +
            "\"traceId\":${valueToJson(traceId)},\"fields\":${valueToJson(fields)}}"
    }

    internal fun sha256Hex(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(text.toByteArray(Charsets.UTF_8))
        return hash.joinToString("") { "%02x".format(it) }
    }

    internal fun valueToJson(value: Any?): String {
        return when (value) {
            null -> "null"
            is String -> "\"${escapeJson(value)}\""
            is Number, is Boolean -> value.toString()
            is Map<*, *> -> value.entries.joinToString(",", "{", "}") { (k, v) ->
                "\"${escapeJson(k.toString())}\":${valueToJson(v)}"
            }
            is Iterable<*> -> value.joinToString(",", "[", "]") { valueToJson(it) }
            is Array<*> -> value.joinToString(",", "[", "]") { valueToJson(it) }
            else -> "\"${escapeJson(value.toString())}\""
        }
    }

    internal fun escapeJson(raw: String): String {
        val out = StringBuilder(raw.length + 8)
        for (c in raw) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                else -> if (c < ' ') out.append("\\u%04x".format(c.code)) else out.append(c)
            }
        }
        return out.toString()
    }
}

/**
 * Capacitor bridge for JS diag events. Contract (fixed by DIAG-JS, not
 * renegotiated here): plugin "FindBackDiag", method "logEvent({json:
 * string})". The JS side redacts before sending; the payload already carries
 * traceId and is appended verbatim so the JSONL sink outlives the WebView.
 *
 * NOTE: this plugin must be registered in MainActivity (outside this task's
 * file lease) with `registerPlugin(FindBackDiagPlugin::class.java)` before
 * JS can reach it.
 */
@CapacitorPlugin(name = "FindBackDiag")
class FindBackDiagPlugin : Plugin() {

    @PluginMethod
    fun logEvent(call: PluginCall) {
        val json = call.getString("json")
        if (json.isNullOrBlank()) {
            call.reject("Missing json")
            return
        }
        if (json.length > Diag.MAX_BRIDGE_JSON_CHARS) {
            call.reject("Diag payload too large")
            return
        }
        try {
            val dir = File(getContext().cacheDir, "diag")
            dir.mkdirs()
            val line = json.trim()
            Diag.fileFor(dir, System.currentTimeMillis()).appendText(line + "\n")
            Diag.pruneOldFiles(dir)
            try {
                Log.i(Diag.TAG, line)
            } catch (_: Exception) {
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("Diag write failed")
        }
    }
}
