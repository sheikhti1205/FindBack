package com.findback.app.vlm

import android.content.Context
import com.google.mediapipe.tasks.text.textembedder.TextEmbedder
import com.google.mediapipe.tasks.core.BaseOptions
import java.util.concurrent.ConcurrentHashMap

/**
 * Universal Sentence Encoder embedder using MediaPipe TextEmbedder.
 * Provides L2-normalized embeddings for text similarity tasks.
 */
class UniversalSentenceEmbedder private constructor(
    private val context: Context,
    private val embedder: TextEmbedder
) {

    companion object {
        // Keyed by application context only. Never hold an Activity context in
        // a process-wide cache or it outlives the Activity lifecycle.
        private val instances = ConcurrentHashMap<Context, UniversalSentenceEmbedder>()

        /**
         * Gets or creates a UniversalSentenceEmbedder instance.
         * Always normalizes to the application context.
         *
         * @param context Android context
         * @return UniversalSentenceEmbedder instance, or null if the model asset is missing
         */
        fun getInstance(context: Context): UniversalSentenceEmbedder? {
            val appContext = context.applicationContext
            return instances.getOrPut(appContext) {
                try {
                    val options = TextEmbedder.TextEmbedderOptions.builder()
                        .setBaseOptions(
                            BaseOptions.builder()
                                .setModelAssetPath("models/use/universal_sentence_encoder.tflite")
                                .build()
                        )
                        .setL2Normalize(true)
                        .setQuantize(false)
                        .build()
                    val embedder = TextEmbedder.createFromOptions(appContext, options)
                    UniversalSentenceEmbedder(appContext, embedder)
                } catch (e: Exception) {
                    // Model asset not found or other initialization error
                    null
                }
            }
        }
    }

    /**
     * Embeds a list of texts and returns L2-normalized float vectors.
     *
     * @param texts List of text strings to embed
     * @return List of embedding vectors (each vector is a List<Float>)
     * @throws IllegalStateException if the embedder is not initialized
     */
    fun embedTexts(texts: List<String>): List<List<Float>> {
        return texts.map { text ->
            val result = embedder.embed(text)
            val embeddings = result.embeddingResult().embeddings()
            if (embeddings.isEmpty()) {
                throw IllegalStateException("No embeddings returned for text: $text")
            }
            val floatEmbedding = embeddings.first().floatEmbedding()
            floatEmbedding.map { it.toFloat() }
        }
    }

    /**
     * Releases the embedder resources.
     */
    fun release() {
        embedder.close()
        instances.remove(context)
    }
}