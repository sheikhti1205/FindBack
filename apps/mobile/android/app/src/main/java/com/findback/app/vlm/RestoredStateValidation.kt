package com.findback.app.vlm

/**
 * WP3 (audit #3): environment-bound validation of persisted GPU verdicts.
 *
 * A persisted READY_GPU / GPU_UNAVAILABLE is a verdict about the exact
 * environment it was measured in (app build, OS fingerprint, ABI, model
 * revision, runtime). Trusting it verbatim after any of those change lets a
 * stale verdict authorize (or block) GPU inference on a device it was never
 * measured on. Downgraded states fall back to INSTALLED_UNVERIFIED: the
 * files are still present, only the GPU verdict needs re-measuring.
 * Non-verdict states (transfers, errors) pass through unchanged.
 */
internal fun validatedRestoredState(
    record: ModelStateRecord?,
    manifest: ModelManifest,
    currentAppVersion: String,
    currentFingerprint: String,
    currentAbi: String
): VlmState {
    val state = record?.state ?: return VlmState.NOT_INSTALLED
    if (state != VlmState.READY_GPU && state != VlmState.GPU_UNAVAILABLE) return state
    if (record.appVersion != currentAppVersion) return VlmState.INSTALLED_UNVERIFIED
    if (record.fingerprint != currentFingerprint) return VlmState.INSTALLED_UNVERIFIED
    if (record.abi != currentAbi) return VlmState.INSTALLED_UNVERIFIED
    if (record.revision != manifest.revision) return VlmState.INSTALLED_UNVERIFIED
    if (record.runtimeVersion != manifest.runtime) return VlmState.INSTALLED_UNVERIFIED
    return state
}
