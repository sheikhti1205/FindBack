package com.findback.app.vlm

import android.content.Context
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Content
import java.io.File

/**
 * VLM Engine for SmolVLM2 500M model using LiteRT-LM with GPU backend.
 * Uses GPU for both backend and visionBackend. Creates a fresh conversation per image.
 */
class VlmEngine500(
    private val context: Context,
    private val modelPath: String,
    private val cacheDir: File
) {

    private var engine: Engine? = null
    private var initialized = false

    /**
     * Initializes the engine. Must be called before analyze().
     */
    fun initialize() {
        if (initialized) return

        val config = EngineConfig(
            modelPath = modelPath,
            backend = Backend.GPU(),
            visionBackend = Backend.GPU(),
            audioBackend = null,
            maxNumTokens = 2048,
            maxNumImages = 1,
            cacheDir = cacheDir.absolutePath
        )

        engine = Engine(config)
        engine?.initialize()
        initialized = true
    }

    /**
     * Analyzes an image with the given instruction.
     * Creates a fresh conversation for each image and closes it immediately after.
     *
     * @param preparedImage The prepared image with absolute path.
     * @param instruction The user instruction/prompt.
     * @param maxOutputTokens Maximum output tokens.
     * @param temperature Sampling temperature.
     * @return The generated text response.
     */
    fun analyze(
        preparedImage: ImagePreparer.PreparedImage,
        instruction: String,
        maxOutputTokens: Int,
        temperature: Float
    ): String {
        if (!initialized) {
            throw IllegalStateException("Engine not initialized. Call initialize() first.")
        }

        val engineInstance = engine!!
        val conversation = engineInstance.createConversation(ConversationConfig(
            systemInstruction = Contents.of(instruction),
            samplerConfig = SamplerConfig(
                topK = 40,
                topP = 0.95,
                temperature = temperature.toDouble(),
                seed = 0
            ),
            maxOutputToken = maxOutputTokens
        ))

        try {
            val response = conversation.sendMessage(
                Contents.of(
                    Content.ImageFile(preparedImage.absolutePath),
                    Content.Text(instruction)
                )
            )

            return response.contents.contents
                .filterIsInstance<Content.Text>()
                .joinToString("") { it.text }
        } finally {
            conversation.close()
        }
    }

    /**
     * Runs a GPU self-test with an optional image.
     * If imageUri is provided, runs a real image-bearing generation.
     * If imageUri is null, only initializes the engine and returns diagnostics.
     *
     * @param imageUri Optional image URI for a real self-test.
     * @param instruction The instruction to use for self-test.
     * @return Pair of (success: Boolean, diagnostics: List<String>)
     */
    fun runSelfTest(
        imageUri: String?,
        instruction: String
    ): Pair<Boolean, List<String>> {
        val diagnostics = mutableListOf<String>()

        try {
            initialize()
            diagnostics.add("Engine initialized with GPU backend")

            if (imageUri != null) {
                // Real image-bearing self-test
                val prepared = ImagePreparer.prepare(context, imageUri)
                try {
                    val result = analyze(prepared, instruction, 64, 0.1f)
                    diagnostics.add("Self-test generation completed: ${result.take(100)}")
                    return Pair(EnginePolicy.selfTestPassed(result), diagnostics.toList())
                } finally {
                    ImagePreparer.cleanup(prepared)
                }
            } else {
                // GPU init diagnostics only - no image, no READY_GPU
                diagnostics.add("GPU backend initialized without image test")
                return Pair(false, diagnostics.toList())
            }
        } catch (e: Exception) {
            diagnostics.add("Self-test failed: ${e.message}")
            return Pair(false, diagnostics.toList())
        }
    }

    /**
     * Releases engine resources.
     */
    fun release() {
        engine?.close()
        engine = null
        initialized = false
    }
}