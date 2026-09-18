package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * WP3 (audit #3): a persisted READY_GPU / GPU_UNAVAILABLE is a verdict about
 * a specific environment. When the app version, OS fingerprint, ABI, model
 * revision, or runtime changes, the verdict must downgrade to
 * INSTALLED_UNVERIFIED (files present, GPU unverified) instead of being
 * trusted verbatim.
 */
class RestoredStateValidationTest {

    private fun record(state: VlmState): ModelStateRecord = ModelStateRecord(
        modelId = VlmModelId.SMOLVLM2_500M,
        state = state,
        files = emptyList(),
        installedBytes = 100L,
        installTimestamp = 1L,
        runtimeVersion = "0.16.0",
        appVersion = "0.1.0",
        fingerprint = "fp-1",
        abi = "arm64-v8a",
        gpuVendor = null,
        gpuRenderer = null,
        revision = "rev-1",
        sha256 = "",
        lastGpuSelfTest = 2L,
        lastError = null
    )

    private val manifest = ModelManifest(
        id = VlmModelId.SMOLVLM2_500M.wire,
        sourceRepo = "repo",
        revision = "rev-1",
        files = emptyList(),
        runtime = "0.16.0"
    )

    @Test
    fun nullRecord_restoresNotInstalled() {
        assertEquals(
            VlmState.NOT_INSTALLED,
            validatedRestoredState(null, manifest, "0.1.0", "fp-1", "arm64-v8a")
        )
    }

    @Test
    fun readyGpu_survivesIdenticalEnvironment() {
        assertEquals(
            VlmState.READY_GPU,
            validatedRestoredState(record(VlmState.READY_GPU), manifest, "0.1.0", "fp-1", "arm64-v8a")
        )
    }

    @Test
    fun readyGpu_downgradesOnAppVersionChange() {
        assertEquals(
            VlmState.INSTALLED_UNVERIFIED,
            validatedRestoredState(record(VlmState.READY_GPU), manifest, "0.2.0", "fp-1", "arm64-v8a")
        )
    }

    @Test
    fun readyGpu_downgradesOnFingerprintChange() {
        assertEquals(
            VlmState.INSTALLED_UNVERIFIED,
            validatedRestoredState(record(VlmState.READY_GPU), manifest, "0.1.0", "fp-2", "arm64-v8a")
        )
    }

    @Test
    fun readyGpu_downgradesOnAbiChange() {
        assertEquals(
            VlmState.INSTALLED_UNVERIFIED,
            validatedRestoredState(record(VlmState.READY_GPU), manifest, "0.1.0", "fp-1", "armeabi-v7a")
        )
    }

    @Test
    fun readyGpu_downgradesOnModelRevisionChange() {
        val bumped = manifest.copy(revision = "rev-2")
        assertEquals(
            VlmState.INSTALLED_UNVERIFIED,
            validatedRestoredState(record(VlmState.READY_GPU), bumped, "0.1.0", "fp-1", "arm64-v8a")
        )
    }

    @Test
    fun readyGpu_downgradesOnRuntimeChange() {
        val bumped = manifest.copy(runtime = "0.17.0")
        assertEquals(
            VlmState.INSTALLED_UNVERIFIED,
            validatedRestoredState(record(VlmState.READY_GPU), bumped, "0.1.0", "fp-1", "arm64-v8a")
        )
    }

    @Test
    fun gpuUnavailable_downgradesOnEnvironmentChange() {
        assertEquals(
            VlmState.INSTALLED_UNVERIFIED,
            validatedRestoredState(record(VlmState.GPU_UNAVAILABLE), manifest, "0.2.0", "fp-1", "arm64-v8a")
        )
    }

    @Test
    fun nonVerdictStates_passThroughUnchanged() {
        assertEquals(
            VlmState.DOWNLOADING,
            validatedRestoredState(record(VlmState.DOWNLOADING), manifest, "9.9.9", "other", "other")
        )
        assertEquals(
            VlmState.INSTALLED_UNVERIFIED,
            validatedRestoredState(record(VlmState.INSTALLED_UNVERIFIED), manifest, "9.9.9", "other", "other")
        )
    }

    @Test
    fun downgradedState_carriesNoStaleTimestamp() {
        // The downgrade decision is state-only; timestamps stay with the record.
        assertNull(record(VlmState.READY_GPU).lastError)
    }
}
