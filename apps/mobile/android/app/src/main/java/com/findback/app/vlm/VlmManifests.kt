package com.findback.app.vlm

/**
 * Pinned model manifests for the two supported VLM models.
 * Revisions, byte counts, and SHA-256 values are from Locked Decisions / RESOLVED_MODEL_FACTS.json.
 */
val MODEL_MANIFESTS: List<ModelManifest> = listOf(
    ModelManifest(
        id = "smolvlm2-500m",
        sourceRepo = "litert-community/SmolVLM2-500M",
        revision = "dad030b6e56756201d670cfb4d042736a2ce3a5c",
        runtime = "com.google.ai.edge.litertlm:litertlm-android:0.16.0",
        files = listOf(
            ModelFileSpec(
                path = "SmolVLM2-500M.litertlm",
                expectedBytes = 360822960L,
                sha256 = "b808b328d845a600a33c5295f93d9217487317bd334dbc91b2a8d50e26e60ad0"
            )
        )
    ),
    ModelManifest(
        id = "smolvlm-256m",
        sourceRepo = "litert-community/SmolVLM-256M-Instruct",
        revision = "dc16f6046d86c646bcc5dfe249c879d028f8b2f2",
        runtime = "com.google.ai.edge.litert:litert:1.4.2+litert-gpu:1.4.2",
        files = listOf(
            ModelFileSpec(
                path = "smolvlm-256m-instruct_q8_ekv2048_single_image.tflite",
                expectedBytes = 288229208L,
                sha256 = "48991855eb6365aae8cd1d8fe3013e6059dfea44b4ae26dd76dfa2a942dba3c4"
            ),
            ModelFileSpec(
                path = "tokenizer.model",
                expectedBytes = 881895L,
                sha256 = "6682f47d3b33538490b21265ba3b2a83f8d48e09dcd7f957b46b508abb427a04"
            )
        )
    )
)