package com.findback.app.vlm

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/** Real installed Smol probe, with a fake execution seam for hermetic JVM tests.
 * CPU language decoder on both arms; only the vision backend differs, as in product inference.
 * Never counts chunks/words as tokens: reads LiteRT's BenchmarkInfo counters.
 */
class RuntimeTimingRunner(
    private val verifiedFile: () -> File?,
    private val execute: (File, String) -> List<Sample>,
) : DeviceProbe.TimingRunner {
    data class Sample(val text: String, val ttftSeconds: Double, val decodeTokensPerSecond: Double)

    override fun run(backend: String): DeviceProbe.TimingResult? {
        if (backend != "cpu" && backend != "gpu") return null
        val file = verifiedFile() ?: return null
        val samples = execute(file, backend)
        if (samples.size != 2 || samples.any {
            !it.ttftSeconds.isFinite() || it.ttftSeconds <= 0.0 ||
                !it.decodeTokensPerSecond.isFinite() || it.decodeTokensPerSecond <= 0.0
        }) return null
        val colors = listOf("red", "blue")
        val correctness = samples.withIndex().all { (index, sample) ->
            val text = sample.text.lowercase().trim()
            // The corpus asks for the color only: mentions, negation, guesses and loops fail.
            Regex("${colors[index]}[.!]?").matches(text)
        }
        return DeviceProbe.TimingResult(
            ttftMs = samples.map { it.ttftSeconds * 1000.0 }.average(),
            tokensPerSec = samples.map { it.decodeTokensPerSecond }.average(),
            correctnessPass = correctness,
        )
    }

    companion object {
        const val MODEL_ID = "smolvlm2-500M-vision"
        const val MODEL_REV = "dad030b6e56756201d670cfb4d042736a2ce3a5c"
        const val MODEL_SHA = "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0"
        const val CORPUS_VERSION = "smol-color-plate-v1"

        fun installedFile(context: Context): File = File(context.filesDir,
            "ai-models/models/$MODEL_ID/$MODEL_REV/SmolVLM2-500M.litertlm")

        @OptIn(com.google.ai.edge.litertlm.ExperimentalApi::class)
        fun forInstalledSmol(context: Context): RuntimeTimingRunner = RuntimeTimingRunner(
            verifiedFile = {
                installedFile(context).takeIf { file ->
                    file.isFile && file.length() == 360822960L && sha256(file) == MODEL_SHA
                }
            },
            execute = { file, backend ->
                val engine = Engine(EngineConfig(
                    modelPath = file.absolutePath, backend = Backend.CPU(),
                    visionBackend = if (backend == "gpu") Backend.GPU() else Backend.CPU(),
                    audioBackend = Backend.CPU(), cacheDir = context.cacheDir.path,
                ))
                try {
                    engine.initialize()
                    listOf(Color.RED, Color.BLUE).map { color ->
                        val bitmap = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888)
                        val bytes = try {
                            bitmap.eraseColor(color)
                            ByteArrayOutputStream().use { stream ->
                                check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
                                stream.toByteArray()
                            }
                        } finally { bitmap.recycle() }
                        val conversation = engine.createConversation(ConversationConfig(
                            samplerConfig = SamplerConfig(topK = 40, topP = 1.0, temperature = 0.0),
                            maxOutputToken = 24,
                        ))
                        try {
                            val output = StringBuilder()
                            runBlocking {
                                withTimeout(60_000L) {
                                    conversation.sendMessageAsync(Contents.of(
                                        Content.ImageBytes(bytes),
                                        Content.Text("What is the main color of this image? Answer with the color only."),
                                    )).collect { message -> output.append(message.toString()) }
                                }
                            }
                            val counters = conversation.getBenchmarkInfo()
                            Sample(output.toString(), counters.timeToFirstTokenInSecond,
                                counters.lastDecodeTokensPerSecond)
                        } finally {
                            try { conversation.cancelProcess() } finally { conversation.close() }
                        }
                    }
                } finally { engine.close() }
            },
        )

        private fun sha256(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val size = input.read(buffer)
                    if (size < 0) break
                    digest.update(buffer, 0, size)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
