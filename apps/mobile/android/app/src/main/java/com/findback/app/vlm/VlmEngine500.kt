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
        // The full instruction arrives once, in the user message alongside the
        // image. The system slot carries only the short role so prompt tokens
        // are not duplicated in context.
        val conversation = engineInstance.createConversation(ConversationConfig(
            systemInstruction = Contents.of("You are a local visual assistant for a lost-and-found report."),
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
     * Failures are classified by stage (audit #25): engine init problems are
     * MODEL_RUNTIME_ERROR, image preparation problems are INPUT_ERROR, and
     * generation problems are GENERATION_ERROR.
     *
     * @param imageUri Optional image URI for a real self-test.
     * @param instruction The instruction to use for self-test.
     * @return Structured outcome with success flag, failure class, diagnostics.
     */
    fun runSelfTest(
        imageUri: String?,
        instruction: String
    ): SelfTestOutcome {
        val diagnostics = mutableListOf<String>()

        try {
            initialize()
        } catch (e: Exception) {
            diagnostics.add("Engine init failed: ${e.message}")
            return SelfTestOutcome(false, SelfTestFailure.MODEL_RUNTIME_ERROR, diagnostics.toList())
        }
        diagnostics.add("Engine initialized with GPU backend")

        if (imageUri == null) {
            // GPU init diagnostics only - no image, no READY_GPU
            diagnostics.add("GPU backend initialized without image test")
            return SelfTestOutcome(false, null, diagnostics.toList())
        }

        // Real image-bearing self-test
        val prepared = try {
            ImagePreparer.prepare(context, imageUri)
        } catch (e: Exception) {
            diagnostics.add("Image preparation failed: ${e.message}")
            return SelfTestOutcome(false, SelfTestFailure.INPUT_ERROR, diagnostics.toList())
        }
        try {
            val result = analyze(prepared, instruction, 64, 0.1f)
            diagnostics.add("Self-test generation completed: ${result.take(100)}")
            return if (EnginePolicy.selfTestPassed(result)) {
                SelfTestOutcome(true, null, diagnostics.toList())
            } else {
                diagnostics.add("Self-test generation produced no usable output")
                SelfTestOutcome(false, SelfTestFailure.GENERATION_ERROR, diagnostics.toList())
            }
        } catch (e: Exception) {
            diagnostics.add("Self-test generation failed: ${e.message}")
            return SelfTestOutcome(false, SelfTestFailure.GENERATION_ERROR, diagnostics.toList())
        } finally {
            ImagePreparer.cleanup(prepared)
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