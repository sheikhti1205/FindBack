package com.findback.app.vlm

/** Shipped package trust comes from native pins, never JS or a package manifest. */
data class KnownPackageIdentity(val catalogueId: String, val manifest: ModelManifest, val packageSha256: String) {
    companion object {
        fun forCatalogueId(id: String): KnownPackageIdentity? = when (id) {
            "smolvlm2-500m-litert-int4" -> MODEL_MANIFESTS.single { it.id == "smolvlm2-500m" }.let {
                KnownPackageIdentity(id, it, it.distribution!!.sha256)
            }
            QwenTextRuntime.ENTRY_ID -> QwenTextRuntime.manifest().let {
                KnownPackageIdentity(id, it, it.distribution!!.sha256)
            }
            else -> null
        }
    }
}
