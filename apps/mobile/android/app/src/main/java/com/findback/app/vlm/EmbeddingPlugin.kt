package com.findback.app.vlm

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Non-generative on-device similarity; independent of archived VLM engines. */
@CapacitorPlugin(name = "FindBackEmbeddings")
class EmbeddingPlugin : Plugin() {
    companion object {
        const val MAX_TEXTS = 21
        const val MAX_TEXT_LENGTH = 5000

        /**
         * Pure input validation shared with JVM tests. Returns the validated
         * texts or null when the batch must be rejected without touching the
         * native embedder. Never logs or echoes the texts.
         */
        fun validatedTexts(items: List<String?>): List<String>? {
            if (items.isEmpty() || items.size > MAX_TEXTS) return null
            return try {
                items.map { item ->
                    if (item.isNullOrBlank() || item.length > MAX_TEXT_LENGTH) return null
                    item
                }
            } catch (_: Exception) { null }
        }
    }

    @PluginMethod
    fun embedTexts(call: PluginCall) {
        val items = call.getArray("texts")
        val raw: List<String?> = if (items == null) {
            call.reject("Invalid embedding input"); return
        } else try {
            (0 until items.length()).map { index -> items.getString(index) }
        } catch (_: Exception) { call.reject("Invalid embedding input"); return }
        val texts = validatedTexts(raw)
        if (texts == null) { call.reject("Invalid embedding input"); return }

        try {
            val embedder = UniversalSentenceEmbedder.getInstance(context)
            if (embedder == null) { call.reject("Embedding model unavailable"); return }
            val vectors = JSArray()
            for (vector in embedder.embedTexts(texts)) {
                val row = JSArray()
                for (component in vector) row.put(component)
                vectors.put(row)
            }
            val result = JSObject()
            result.put("vectors", vectors)
            call.resolve(result)
        } catch (_: Exception) {
            // Never echo input texts (which may contain private report details).
            call.reject("Embedding unavailable")
        }
    }
}
