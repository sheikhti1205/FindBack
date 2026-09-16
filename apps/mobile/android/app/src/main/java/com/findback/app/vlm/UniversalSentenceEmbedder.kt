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
        private val instances = ConcurrentHashMap<Context, UniversalSentenceEmbedder>()

        /**
         * Gets or creates a UniversalSentenceEmbedder instance for the given context.
         * The embedder is cached per context to avoid reloading the model.
         *
         * @param context Android context
         * @return UniversalSentenceEmbedder instance, or null if the model asset is missing
         */
        @Suppress("UNUSED_PARAMETER")
        fun getInstance(context: Context): UniversalSentenceEmbedder? {
            return instances.getOrPut(context) {
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
                    val embedder = TextEmbedder.createFromOptions(context, options)
                    UniversalSentenceEmbedder(context, embedder)
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