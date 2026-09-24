package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unknown commit gating: explicit confirmed bounded name+role plus a
 * successful probe, or a typed memory failure plus explicit
 * keepUnverified. Incompatible probes can never be kept.
 */
class ImportCommitPolicyTest {

    private fun ready() = InspectedProbeClassifier.classifySuccess(1, 2, 3, 4, nonemptyOutput = true)
    private fun lowMemory() = InspectedProbeClassifier.classifyFailure(OutOfMemoryError("heap"))
    private fun incompatible() = InspectedProbeClassifier.classifyFailure(IllegalStateException("Unsupported op"))

    @Test
    fun successfulProbeCommitsWithConfirmedNameAndRole() {
        val ok = ImportCommitPolicy.validateUnknown("My Model", "Text", "plain desc", keepUnverified = false, probe = ready(), probedRole = "Text")
        assertTrue(ok.ok, ok.reason)
    }

    @Test
    fun blankNameOrRoleRejects() {
        assertFalse(ImportCommitPolicy.validateUnknown("  ", "Text", null, false, ready(), "Text").ok)
        assertFalse(ImportCommitPolicy.validateUnknown("Name", null, null, false, ready(), null).ok)
        assertFalse(ImportCommitPolicy.validateUnknown("Name", "Audio", null, false, ready(), "Audio").ok)
    }

    @Test
    fun memoryFailureNeedsExplicitKeepUnverified() {
        assertFalse(ImportCommitPolicy.validateUnknown("My Model", "Vision", null, false, lowMemory(), "Vision").ok)
        assertTrue(ImportCommitPolicy.validateUnknown("My Model", "Vision", null, true, lowMemory(), "Vision").ok)
    }

    @Test
    fun incompatibleProbeCanNeverBeKept() {
        assertFalse(ImportCommitPolicy.validateUnknown("My Model", "Text", null, false, incompatible(), "Text").ok)
        assertFalse(ImportCommitPolicy.validateUnknown("My Model", "Text", null, true, incompatible(), "Text").ok)
        assertFalse(ImportCommitPolicy.validateUnknown("My Model", "Text", null, false, null, null).ok)
    }

    @Test
    fun switchingRoleAfterProbeCannotImportUnderAnUntestedRole() {
        val testedText = ready()
        assertFalse(ImportCommitPolicy.validateUnknown(
            "My Model", "Vision", null, false, testedText, probedRole = "Text"
        ).ok)
        assertTrue(ImportCommitPolicy.validateUnknown(
            "My Model", "Text", null, false, testedText, probedRole = "Text"
        ).ok)
    }

    @Test
    fun namespacedIdIsFullSha256() {
        val sha = "41e11106a57ae750f61d992ab195f90b9f7bc58c39009b5dac0ce9d1c60a366e"
        assertTrue(ImportCommitPolicy.isNamespacedEntryId(sha))
        assertFalse(ImportCommitPolicy.isNamespacedEntryId("custom-model"))
        assertFalse(ImportCommitPolicy.isNamespacedEntryId("../escape"))
    }
}
