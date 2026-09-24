package com.findback.app.vlm

import java.io.File

/**
 * Phase A six-model catalogue: the two official release-package entries plus
 * the four experimental raw-weight candidates. This is the single native-side
 * source of truth for which entry IDs may travel the catalogue
 * export/re-export path (as opposed to the unknown user-import path).
 *
 * Official release packages (exact whole-package SHA-256 via
 * [KnownPackageIdentity]) keep their byte-identical checks unweakened; the
 * four experimental IDs have no whole-package pin — their trust comes from
 * independently pinned installed weights ([PinnedModelSources]) plus the
 * per-entry native-side trust tombstone ([ExportTrustStore]) recorded at
 * download/verify time. A package manifest's self-declaration alone is never
 * sufficient.
 */
object SixModelCatalogue {
    const val SMOL_ENTRY = "smolvlm2-500m-litert-int4"
    const val QWEN_DYNAMIC_ENTRY = "qwen3-0.6b-litert-dynamic-int4"
    const val QWEN_MIXED_ENTRY = "qwen3-0.6b-litert-mixed-int4"
    const val QWEN_INT8_ENTRY = "qwen3-0.6b-litert-int8"
    const val LFM_INSTRUCT_ENTRY = "lfm2.5-1.2b-instruct-litert-int4-gpu"
    const val LFM_VL_ENTRY = "lfm2.5-vl-450m"

    /** All six catalogue entry IDs accepted on the re-export path. */
    val ALL_SIX: List<String> = listOf(
        SMOL_ENTRY,
        QWEN_DYNAMIC_ENTRY,
        QWEN_MIXED_ENTRY,
        QWEN_INT8_ENTRY,
        LFM_INSTRUCT_ENTRY,
        LFM_VL_ENTRY
    )

    fun isCatalogueId(id: String): Boolean = ALL_SIX.contains(id)

    /**
     * Authoritative installed-weights manifest for a catalogue id, or null
     * when the id is not one of the six. Official entries resolve via
     * [KnownPackageIdentity]; experimental entries resolve via
     * [PinnedModelSources]. The LFM VL fixB entry ("..._fixB.litertlm") IS a
     * pinned candidate record here — historically it had no prepared
     * `.fbmodel` whole-package pin (see [KnownPackageIdentity], which stays
     * null for it), only pinned raw installed weights; that caveat is
     * preserved, not erased.
     */
    fun manifestForCatalogueId(id: String): ModelManifest? {
        KnownPackageIdentity.forCatalogueId(id)?.let { return it.manifest }
        PinnedModelSources.manifests.singleOrNull { it.id == id }?.let { return it }
        return null
    }

    /**
     * Catalogue entry id for an installed manifest id. The 500M image
     * manifest id (`smolvlm2-500m`) maps to its package catalogue id
     * ([SMOL_ENTRY]); every other manifest id already equals its catalogue id.
     */
    fun catalogueIdForManifestId(manifestId: String): String? = when (manifestId) {
        "smolvlm2-500m" -> SMOL_ENTRY
        QwenTextRuntime.ENTRY_ID -> QwenTextRuntime.ENTRY_ID
        else -> PinnedModelSources.manifests.singleOrNull { it.id == manifestId }?.id
    }

    /**
     * Trusted native-side artifact pins for [catalogueId]: the shipped
     * interior pins when present, else the tombstoned pins recorded at
     * download/verify time. Returns null when neither exists — a
     * self-declared manifest alone never counts as trusted.
     */
    fun trustedArtifactPins(storeRoot: File, catalogueId: String): List<ModelFileSpec>? {
        if (!isCatalogueId(catalogueId)) return null
        ExportTrustStore.trustedFor(storeRoot, catalogueId)?.let { return it }
        return manifestForCatalogueId(catalogueId)?.files
    }
}
