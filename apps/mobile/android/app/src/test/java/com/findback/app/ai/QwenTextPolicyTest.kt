package com.findback.app.ai

import org.junit.Assert.*
import org.junit.Test

class QwenTextPolicyTest {
    @Test fun sessionFloorHoldsAt1024() {
        // Profile notes a 1024 session floor for Qwen: smaller requests
        // still open a 1024 session; the per-call cap does the limiting.
        assertEquals(1024, QwenTextPolicy.clampSessionMaxTokens(null))
        assertEquals(1024, QwenTextPolicy.clampSessionMaxTokens(256))
        assertEquals(1024, QwenTextPolicy.clampSessionMaxTokens(1024))
        assertEquals(2048, QwenTextPolicy.clampSessionMaxTokens(999_999))
    }

    @Test fun callCeilingNeverExceedsSession() {
        assertEquals(256, QwenTextPolicy.clampCallMaxTokens(null, 1024))
        assertEquals(256, QwenTextPolicy.clampCallMaxTokens(0, 1024))
        assertEquals(256, QwenTextPolicy.clampCallMaxTokens(-5, 1024))
        assertEquals(1024, QwenTextPolicy.clampCallMaxTokens(4096, 1024))
        assertEquals(100, QwenTextPolicy.clampCallMaxTokens(100, 1024))
    }

    @Test fun promptBoundsAreFailClosed() {
        assertFalse(QwenTextPolicy.isPromptAcceptable(null))
        assertFalse(QwenTextPolicy.isPromptAcceptable(""))
        assertFalse(QwenTextPolicy.isPromptAcceptable("   "))
        assertTrue(QwenTextPolicy.isPromptAcceptable("Describe the item."))
        assertFalse(QwenTextPolicy.isPromptAcceptable("x".repeat(QwenTextPolicy.MAX_PROMPT_CHARS + 1)))
        assertTrue(QwenTextPolicy.isPromptAcceptable("x".repeat(QwenTextPolicy.MAX_PROMPT_CHARS)))
    }

    @Test fun modelIdsRejectTraversal() {
        assertTrue(QwenTextPolicy.isModelIdWellFormed("qwen3-0.6b-dynamic-int4"))
        assertFalse(QwenTextPolicy.isModelIdWellFormed(null))
        assertFalse(QwenTextPolicy.isModelIdWellFormed(""))
        assertFalse(QwenTextPolicy.isModelIdWellFormed("../../etc"))
        assertFalse(QwenTextPolicy.isModelIdWellFormed("a/b"))
    }

    @Test fun pinsProductionQwenArtifact() {
        assertEquals("qwen3-0.6b-dynamic-int4", QwenTextPolicy.QWEN_MODEL_ID)
        assertEquals("Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm", QwenTextPolicy.QWEN_FILE_NAME)
    }
}
