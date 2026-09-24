package com.findback.app.vlm

import java.io.File

/**
 * A downloaded part or an unverified final file must never be reported as usable.
 *
 * Verified state is served through [VerifiedWeightsCache]: the verdict is
 * cached keyed by size+mtime (plus the expected hash), so an unchanged file
 * is not re-hashed on every refresh and only a changed file pays for a
 * re-hash. The invalidation key is
 * (canonicalPath, length, lastModified, expectedSha256).
 */
object CandidateModelStatus {
    fun hasVerifiedWeights(store: ModelStore, manifest: ModelManifest): Boolean =
        VerifiedWeightsCache.hasVerifiedWeights(store, manifest)

    /** Test/bounded-refresh entry point with an injectable hasher. */
    fun hasVerifiedWeights(
        store: ModelStore,
        manifest: ModelManifest,
        hasher: (File, String) -> Boolean
    ): Boolean = VerifiedWeightsCache.hasVerifiedWeights(store, manifest, hasher)

    fun visibleState(installed: Boolean, verifiedOnDevice: Boolean, transfer: VlmState): String =
        if (installed) {
            if (verifiedOnDevice) "READY" else "INSTALLED_UNVERIFIED"
        } else if (transfer == VlmState.INSTALLED_UNVERIFIED || transfer == VlmState.READY_GPU) {
            VlmState.NOT_INSTALLED.wire
        } else {
            transfer.wire
        }
}
