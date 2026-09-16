package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class EnginePolicyTest {
    @Test fun onlyEverReportsGpu() {
        assertEquals("gpu", EnginePolicy.backendName())
    }
    @Test fun selfTestRequiresNonEmptySaneText() {
        assertFalse(EnginePolicy.selfTestPassed(""))
        assertFalse(EnginePolicy.selfTestPassed("   "))
        assertTrue(EnginePolicy.selfTestPassed("a small object"))
    }
}