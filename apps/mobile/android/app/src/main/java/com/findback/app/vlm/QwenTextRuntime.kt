package com.findback.app.vlm

/**
 * Identity and pin for the single qualified on-device text runtime.
 *
 * The bridge-level model id (`qwen3-0.6b`) is the only id the text bridge
 * accepts; every other id — including the catalogue entry id, the profile
 * id, and the image model ids — is rejected. The pin tracks the INSTALLED
 * weights artifact (upstream revision, installed bytes, installed-weights
 * hash), not the distribution package, which differs by design.
 */
object QwenTextRuntime {
    const val BRIDGE_MODEL_ID = "qwen3-0.6b"
    const val ENTRY_ID = "qwen3-0.6b-litert-dynamic-int4"
    const val MODEL_FILE_NAME = "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm"
    const val REVISION = "a3c5d805ae362dff7f580bc25f2dfb9a5a7eaa76"
    const val INSTALLED_BYTES = 344671744L
    const val INSTALLED_SHA256 =
        "03e7da1eb1108b50dffaa9bb52cc7bcbad2eb0c66ca990267f480c1e545d2856"
    const val RUNTIME = "com.google.ai.edge.litertlm:litertlm-android:0.16.0"
    const val SOURCE_REPO = "litert-community/Qwen3-0.6B"

    const val DISTRIBUTION_REPO = "sheikhti1205/FindBack-Models"
    const val DISTRIBUTION_TAG = "models-2026-09-22-v1"
    const val DISTRIBUTION_ASSET = "qwen3-0.6b-litert-dynamic-int4.fbmodel"
    const val DISTRIBUTION_BYTES = 344672709L
    const val DISTRIBUTION_SHA256 =
        "83109b67d59e349e7fdbd178a4742030656813edd9442c8713ca71b38e4a1efb"

    /**
     * True only for the exact qualified bridge model id. Null, blank, and
     * every other id are rejected so the bridge can never substitute
     * another model.
     */
    fun isAcceptedModelId(modelId: String?): Boolean = modelId == BRIDGE_MODEL_ID

    /**
     * Returns the accepted model id or throws. The message names the
     * expected id so misrouted callers can diagnose the mismatch.
     */
    fun requireAcceptedModelId(modelId: String?): String {
        if (!isAcceptedModelId(modelId)) {
            throw IllegalArgumentException(
                "Unsupported text model: ${modelId ?: "<null>"}. " +
                    "This runtime serves only \"$BRIDGE_MODEL_ID\"."
            )
        }
        return BRIDGE_MODEL_ID
    }

    /**
     * Pinned manifest for the qualified text artifact. Installed identity
     * (bytes/hash) tracks the weights on disk; the distribution record
     * tracks the release package and differs by design.
     */
    fun manifest(): ModelManifest = ModelManifest(
        id = ENTRY_ID,
        sourceRepo = SOURCE_REPO,
        revision = REVISION,
        runtime = RUNTIME,
        files = listOf(
            ModelFileSpec(
                path = MODEL_FILE_NAME,
                expectedBytes = INSTALLED_BYTES,
                sha256 = INSTALLED_SHA256
            )
        ),
        distribution = ModelDistribution(
            repo = DISTRIBUTION_REPO,
            tag = DISTRIBUTION_TAG,
            asset = DISTRIBUTION_ASSET,
            bytes = DISTRIBUTION_BYTES,
            sha256 = DISTRIBUTION_SHA256,
            state = DistributionState.PUBLISHED,
            parts = null
        )
    )
}
