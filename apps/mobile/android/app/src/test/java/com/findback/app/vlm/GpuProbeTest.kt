package com.findback.app.vlm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * GpuProbe is the capabilities source for `gpuRuntimePresent`, `gpuVendor`
 * and `gpuRenderer`. These tests pin the delegate class the AAR actually
 * ships and prove the probe degrades instead of throwing.
 */
class GpuProbeTest {

    @Test
    fun `delegate class is the one litert-gpu ships, not the old guess`() {
        assertEquals("org.tensorflow.lite.gpu.GpuDelegate", GpuProbe.GPU_DELEGATE_CLASS)
        // The old probe target never existed; it kept gpuRuntimePresent false
        // on every device.
        var oldClassPresent = true
        try {
            Class.forName("com.google.ai.edge.litert.gpu.GpuDelegate")
        } catch (_: ClassNotFoundException) {
            oldClassPresent = false
        }
        assertFalse(oldClassPresent)
    }

    @Test
    fun `runtime is present because litert-gpu is on the classpath`() {
        // The delegate AAR is a real dependency, so the class resolves even
        // in plain JVM unit tests — exactly what the old name never did.
        assertTrue(GpuProbe.runtimePresent())
    }

    @Test
    fun `info never throws and degrades to unknown without EGL`() {
        val (vendor, renderer) = GpuProbe.info()
        assertNull(vendor)
        assertNull(renderer)
    }
}
