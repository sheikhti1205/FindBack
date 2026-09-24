package com.findback.app.vlm

/** A downloaded part or an unverified final file must never be reported as usable. */
object CandidateModelStatus {
    fun hasVerifiedWeights(store: ModelStore, manifest: ModelManifest): Boolean =
        manifest.files.isNotEmpty() && manifest.files.all { spec ->
            val final = store.finalFile(manifest, spec)
            final.isFile && final.length() == spec.expectedBytes && Sha256.matchesFile(final, spec.sha256)
        }

    fun visibleState(installed: Boolean, verifiedOnDevice: Boolean, transfer: VlmState): String =
        if (installed) {
            if (verifiedOnDevice) "READY" else "INSTALLED_UNVERIFIED"
        } else if (transfer == VlmState.INSTALLED_UNVERIFIED || transfer == VlmState.READY_GPU) {
            VlmState.NOT_INSTALLED.wire
        } else {
            transfer.wire
        }
}
