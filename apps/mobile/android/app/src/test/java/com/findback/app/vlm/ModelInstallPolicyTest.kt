package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ModelInstallPolicyTest {
    @Test fun requiresExpectedPlusLargerOf256MiBOr25Percent() {
        assertEquals(360822960L + 268435456L, ModelInstallPolicy.requiredFreeBytes(360822960L))
        assertEquals(288229208L + 268435456L, ModelInstallPolicy.requiredFreeBytes(288229208L))
        assertEquals(1_000_000_000L + 268435456L, ModelInstallPolicy.requiredFreeBytes(1_000_000_000L))
    }

    @Test fun refusesInstallWhenFreeSpaceIsShort() {
        assertFalse(ModelInstallPolicy.canInstall(freeBytes = 500_000_000L, expectedBytes = 360822960L))
        assertTrue(ModelInstallPolicy.canInstall(freeBytes = 700_000_000L, expectedBytes = 360822960L))
    }

    @Test fun restartsWhenServerIgnoresRangeOrPartIsOversized() {
        assertEquals(ResumeDecision.RESTART, ModelInstallPolicy.resumeDecision(false, 10L, 100L))
        assertEquals(ResumeDecision.RESTART, ModelInstallPolicy.resumeDecision(true, 101L, 100L))
        assertEquals(ResumeDecision.RESUME, ModelInstallPolicy.resumeDecision(true, 40L, 100L))
        assertEquals(ResumeDecision.RESTART, ModelInstallPolicy.resumeDecision(true, 0L, 100L))
    }

    @Test fun hashMismatchIsCorruptAndMatchIsInstalledUnverified() {
        assertEquals(VlmState.CORRUPT, ModelInstallPolicy.stateAfterVerify(false))
        assertEquals(VlmState.INSTALLED_UNVERIFIED, ModelInstallPolicy.stateAfterVerify(true))
    }

    @Test fun invalidatesSelfTestWhenAnyInputChanges() {
        val files = listOf(InstalledFileRecord("model", 360822960L, 360822960L, "hash", "hash"))
        val record = ModelStateRecord(
            modelId = VlmModelId.SMOLVLM2_500M,
            state = VlmState.READY_GPU,
            files = files,
            installedBytes = 360822960L,
            installTimestamp = 1L,
            runtimeVersion = "0.16.0",
            appVersion = "1.0",
            fingerprint = "fp",
            abi = "arm64-v8a",
            gpuVendor = "Qualcomm",
            gpuRenderer = "Adreno",
            revision = "rev",
            sha256 = "hash",
            lastGpuSelfTest = 1L,
            lastError = null
        )
        assertTrue(ModelInstallPolicy.selfTestStillValid(record, "fp", "0.16.0", "1.0", "rev", "hash"))
        assertFalse(ModelInstallPolicy.selfTestStillValid(record, "fp2", "0.16.0", "1.0", "rev", "hash"))
        assertFalse(ModelInstallPolicy.selfTestStillValid(record, "fp", "0.17.0", "1.0", "rev", "hash"))
        assertFalse(ModelInstallPolicy.selfTestStillValid(record, "fp", "0.16.0", "1.1", "rev", "hash"))
        assertFalse(ModelInstallPolicy.selfTestStillValid(record, "fp", "0.16.0", "1.0", "rev2", "hash"))
        assertFalse(ModelInstallPolicy.selfTestStillValid(record, "fp", "0.16.0", "1.0", "rev", "hash2"))
    }
}