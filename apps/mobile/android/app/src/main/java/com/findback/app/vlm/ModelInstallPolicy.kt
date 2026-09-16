package com.findback.app.vlm

/**
 * Resume decision for partial downloads.
 */
enum class ResumeDecision {
    RESUME,
    RESTART
}

/**
 * Pure install policy functions — no I/O, no platform deps.
 * Reuses VlmState, InstalledFileRecord, ModelStateRecord, ModelError, VlmErrorCode from VlmTypes.
 */
object ModelInstallPolicy {
    private const val MIB = 1024L * 1024L

    /**
     * Required free bytes = expectedBytes + max(256 MiB, 25% of expectedBytes).
     */
    fun requiredFreeBytes(expectedBytes: Long): Long =
        expectedBytes + maxOf(256L * MIB, expectedBytes / 4L)

    /**
     * Whether installation can proceed given free space.
     */
    fun canInstall(freeBytes: Long, expectedBytes: Long): Boolean =
        freeBytes >= requiredFreeBytes(expectedBytes)

    /**
     * Decide whether to resume or restart a partial download.
     * Resume only if server supports Range AND partBytes is in [1, expectedBytes).
     */
    fun resumeDecision(serverSupportsRange: Boolean, partBytes: Long, expectedBytes: Long): ResumeDecision =
        if (serverSupportsRange && partBytes in 1 until expectedBytes) ResumeDecision.RESUME else ResumeDecision.RESTART

    /**
     * State after hash verification.
     */
    fun stateAfterVerify(hashMatches: Boolean): VlmState =
        if (hashMatches) VlmState.INSTALLED_UNVERIFIED else VlmState.CORRUPT

    /**
     * Self-test is still valid only if all inputs match exactly.
     */
    fun selfTestStillValid(
        record: ModelStateRecord,
        fingerprint: String,
        runtimeVersion: String,
        appVersion: String,
        revision: String,
        sha256: String
    ): Boolean =
        record.fingerprint == fingerprint &&
        record.runtimeVersion == runtimeVersion &&
        record.appVersion == appVersion &&
        record.revision == revision &&
        record.sha256 == sha256
}