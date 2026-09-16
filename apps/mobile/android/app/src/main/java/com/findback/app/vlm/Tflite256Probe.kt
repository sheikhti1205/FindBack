package com.findback.app.vlm

import android.content.Context
import android.util.Log
import org.tensorflow.lite.InterpreterApi
import org.tensorflow.lite.InterpreterFactory
import org.tensorflow.lite.InterpreterApi.Options.TfLiteRuntime
import org.tensorflow.lite.gpu.GpuDelegateFactory
import org.tensorflow.lite.gpu.GpuDelegate
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel

/**
 * Diagnostic probe for SmolVLM 256M using plain LiteRT + GpuDelegateFactory.
 * Never uses LiteRT-LM. Never creates CPU/XNNPACK fallback.
 * READY_GPU only on complete image-to-text generation success.
 */
class Tflite256Probe(
    private val context: Context,
    private val store: ModelStore,
    private val imagePreparer: ImagePreparer
) {

    private val manifest = MODEL_MANIFESTS.single { it.id == VlmModelId.SMOLVLM_256M.wire }
    private val tfliteSpec = manifest.files.single { it.path.endsWith(".tflite") }
    private val tokenizerSpec = manifest.files.single { it.path == "tokenizer.model" }

    /**
     * Runs the GPU diagnostic probe.
     * Returns the VlmState outcome and optional error code.
     */
    fun runProbe(): Pair<VlmState, VlmErrorCode?> {
        val tfliteFile = store.finalFile(manifest, tfliteSpec)
        val tokenizerFile = store.finalFile(manifest, tokenizerSpec)

        if (!tfliteFile.exists() || !tokenizerFile.exists()) {
            return Pair(VlmState.GPU_UNAVAILABLE, VlmErrorCode.GPU_UNAVAILABLE_ON_CURRENT_RUNTIME)
        }

        var interpreter: InterpreterApi? = null
        var delegateApplied = false
        var fullInferenceCompleted = false

        try {
            // Create GPU delegate with explicit OPENCL backend
            val gpuOptions = GpuDelegateFactory.Options().setForceBackend(GpuDelegateFactory.Options.GpuBackend.OPENCL)
            val gpuDelegate = GpuDelegate(gpuOptions)

            // Create interpreter with GPU delegate
            val options = InterpreterApi.Options()
                .setRuntime(TfLiteRuntime.FROM_APPLICATION_ONLY)
                .addDelegate(gpuDelegate)

            interpreter = InterpreterApi.create(tfliteFile, options)
            delegateApplied = true

            // Load tokenizer (diagnostic - verify it can be read)
            loadTokenizer(tokenizerFile)

            // Attempt full image-to-text generation
            // This is a diagnostic probe - we need a real image to test
            // For now, we record that delegate was applied but full inference requires an image
            // The probe is diagnostic-only: READY_GPU only on complete generation success
            fullInferenceCompleted = attemptFullInference(interpreter!!)

        } catch (e: Exception) {
            Log.w("Tflite256Probe", "Probe failed: ${e.message}")
            delegateApplied = false
            fullInferenceCompleted = false
        } finally {
            interpreter?.close()
        }

        val outcome = ProbePolicy.outcome(delegateApplied, fullInferenceCompleted)
        val reason = ProbePolicy.reasonFor(outcome)
        return Pair(outcome, reason)
    }

    /**
     * Loads and verifies the tokenizer model file.
     */
    private fun loadTokenizer(tokenizerFile: File) {
        // Verify tokenizer file can be read - diagnostic only
        FileInputStream(tokenizerFile).use { input ->
            val buffer = ByteBuffer.allocate(1024)
            val channel = input.channel
            channel.read(buffer)
        }
    }

    /**
     * Attempts a full image-to-text generation.
     * Returns true only if complete generation succeeds.
     * This is a stub - real implementation would require image input and token generation loop.
     */
    private fun attemptFullInference(interpreter: InterpreterApi): Boolean {
        // Diagnostic-only probe: we do not have a bundled test image
        // and the full token generation loop is not implemented here.
        // Per requirements: READY_GPU only on complete image-to-text generation success.
        // Since we cannot run a real generation without an image and tokenizer integration,
        // we return false to indicate GPU_UNAVAILABLE with GPU_UNAVAILABLE_ON_CURRENT_RUNTIME.
        return false
    }
}

/**
 * Policy for mapping probe results to VLM states and error codes.
 * READY_GPU only when both delegate applied AND full inference completed.
 * GPU_UNAVAILABLE always carries GPU_UNAVAILABLE_ON_CURRENT_RUNTIME reason.
 */
object ProbePolicy {
    /**
     * Determines the VLM state based on probe results.
     * @param delegateApplied Whether GPU delegate was successfully created and applied
     * @param fullInferenceCompleted Whether complete image-to-text generation succeeded
     * @return VlmState.READY_GPU only if both are true, otherwise GPU_UNAVAILABLE
     */
    fun outcome(delegateApplied: Boolean, fullInferenceCompleted: Boolean): VlmState {
        return if (delegateApplied && fullInferenceCompleted) {
            VlmState.READY_GPU
        } else {
            VlmState.GPU_UNAVAILABLE
        }
    }

    /**
     * Returns the error code for a given VLM state.
     * GPU_UNAVAILABLE always maps to GPU_UNAVAILABLE_ON_CURRENT_RUNTIME.
     * READY_GPU has no error code (null).
     */
    fun reasonFor(state: VlmState): VlmErrorCode? {
        return when (state) {
            VlmState.GPU_UNAVAILABLE -> VlmErrorCode.GPU_UNAVAILABLE_ON_CURRENT_RUNTIME
            else -> null
        }
    }
}