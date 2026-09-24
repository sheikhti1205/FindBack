package com.findback.app.vlm

import java.net.URL

/** Immutable raw .litertlm identity, never a .fbmodel package or release asset. */
data class PinnedRawSource(
    val repo: String,
    val revision: String,
    val file: String,
    val bytes: Long,
    val sha256: String
) {
    init {
        require(Regex("[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+").matches(repo))
        require(Regex("[0-9a-f]{40}").matches(revision))
        require(Regex("[a-zA-Z0-9._-]+\\.litertlm").matches(file))
        require(bytes > 0)
        require(Regex("[0-9a-f]{64}").matches(sha256))
    }

    fun url(): String = "https://huggingface.co/$repo/resolve/$revision/$file"

    companion object {
        /** Never forward a Range request to an arbitrary host or plaintext URL. */
        fun isApprovedUrl(value: String): Boolean = try {
            val parsed = URL(value)
            parsed.protocol == "https" && parsed.userInfo == null &&
                (parsed.host == "huggingface.co" || parsed.host == "cdn-lfs.huggingface.co" ||
                    parsed.host == "cdn-lfs-us-1.hf.co" || parsed.host == "cas-bridge.xethub.hf.co")
        } catch (_: Exception) {
            false
        }
    }
}

/** Four candidate catalogue entries with independently pinned installed weights. */
object PinnedModelSources {
    private const val RUNTIME = "com.google.ai.edge.litertlm:litertlm-android:0.16.0"
    private const val QWEN_REV = "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76"

    private fun candidate(id: String, source: PinnedRawSource) = ModelManifest(
        id = id,
        sourceRepo = source.repo,
        revision = source.revision,
        files = listOf(ModelFileSpec(source.file, source.bytes, source.sha256)),
        runtime = RUNTIME,
        rawSource = source
    )

    val manifests: List<ModelManifest> = listOf(
        candidate("qwen3-0.6b-litert-mixed-int4", PinnedRawSource(
            "litert-community/Qwen3-0.6B", QWEN_REV, "qwen3_0_6b_mixed_int4.litertlm",
            497516544L, "7900eb4e7362d88c58782c6f9999bb7a129e03544aa98b8f338ea0cc5d8c22c1"
        )),
        candidate("qwen3-0.6b-litert-int8", PinnedRawSource(
            "litert-community/Qwen3-0.6B", QWEN_REV, "Qwen3-0.6B.litertlm",
            614236160L, "555579ff2f4fd13379abe69c1c3ab5200f7338bc92471557f1d6614a6e5ab0b4"
        )),
        candidate("lfm2.5-1.2b-instruct-litert-int4-gpu", PinnedRawSource(
            "litert-community/LFM2.5-1.2B-Instruct", "4ef1641b562b70ffca66ce4fee7bef4446b374b6",
            "LFM2.5-1.2B-Instruct_int4_gpu.litertlm", 736220768L,
            "97e6a9700208f59fce2ceb993cd6c18ea77ada8c2a940f68332004f38a404671"
        )),
        candidate("lfm2.5-vl-450m", PinnedRawSource(
            "litert-community/LFM2.5-VL-450M", "be196f4fa88b2dfba8cdbbbff07b641df794f977",
            "LFM2.5-VL-450M_int4_fixB.litertlm", 406817104L,
            "6854cd9677a34e680070b60076793e49aeb3224de7cb4101076b261cb9bf6033"
        ))
    )
}
